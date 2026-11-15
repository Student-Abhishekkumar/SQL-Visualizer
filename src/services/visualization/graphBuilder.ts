/**
 * Flow-graph builder — V3.
 *
 * Builds a deterministic, inspectable FlowGraph from a
 * VisualizationTrace. Every node references real trace data (source
 * tables, stage snapshots, groups, final rows); edges represent actual
 * data dependencies between snapshots. Nothing is invented: a node that
 * depends on data a stage produces is revealed by playback state, not
 * rendered upfront.
 *
 * Layout: source tables sit in a left column, aligned with the
 * operation that consumes them (so JOIN inputs visibly converge on the
 * JOIN node), and the pipeline runs down a central spine. Rejected rows
 * and GROUP BY groups fan out to a right-hand column. Coordinates and
 * sockets are computed here so they are testable; rendering is separate.
 */

import type {
  FlowElementStatus,
  FlowEdgeKind,
  FlowGraph,
  FlowGraphEdge,
  FlowGraphNode,
  FlowGraphState,
  FlowSocket,
  FlowSocketKind,
  FlowSocketSide,
} from '../../types/flowGraph'
import type {
  GroupSnapshot,
  StageSnapshot,
  VisualizationTrace,
  VisualizedStage,
} from '../../types/visualization'
import { curveMidpoint, routeEdgeCurve } from './flowGeometry'

/** Operations that get a dedicated operation node (FROM is the source load). */
const OPERATION_STAGES = new Set<VisualizedStage>([
  'JOIN',
  'WHERE',
  'GROUP_BY',
  'HAVING',
  'SELECT',
  'DISTINCT',
  'ORDER_BY',
  'LIMIT',
])

/** Stages whose snapshot carries a rejected/skipped branch. */
const BRANCH_STAGES = new Set<VisualizedStage>(['WHERE', 'HAVING', 'DISTINCT', 'LIMIT'])

const MAX_GROUP_NODES = 8

/** Preview rows shown while collapsed (expanded shows up to ten). */
const PREVIEW_ROWS = 3
const EXPANDED_ROWS = 10
/** Rendered height of one extra preview row (title/table metrics). */
const EXPANDED_ROW_HEIGHT = 17

// Layout constants: left source column → central pipeline spine → right
// branch column.
const SOURCE_X = 0
const SOURCE_W = 248
const SOURCE_H = 152
const SOURCE_STACK_GAP = 20
const SPINE_X = 344
const NODE_W = 260
const OP_H = 78
const DATA_H = 128
const OP_DATA_GAP = 28
const ROW_GAP = 36
const SIDE_X = 666
const SIDE_W = 236
const BRANCH_H = 58
const GROUP_H = 54
const GROUP_GAP = 12
const FINAL_H = 136
const TOP = 32

/** Beginner-friendly description of what each stage does. */
const STAGE_HINTS: Partial<Record<VisualizedStage, string>> = {
  JOIN: 'Matching rows from two tables are combined.',
  WHERE: 'Each row is checked against this condition.',
  GROUP_BY: 'Rows are collected into groups by this key.',
  HAVING: 'Groups are filtered by an aggregate condition.',
  SELECT: 'Only these columns are kept (or calculated).',
  DISTINCT: 'Duplicate result rows are removed.',
  ORDER_BY: 'Rows are arranged in this order.',
  LIMIT: 'Only the requested number of rows is kept.',
}

/** Honest description of the dataset a stage produces. */
const DATA_LABELS: Partial<Record<VisualizedStage, string>> = {
  JOIN: 'Joined rows',
  WHERE: 'Filtered rows',
  GROUP_BY: 'Group structure',
  HAVING: 'Kept groups',
  SELECT: 'Projected rows',
  DISTINCT: 'Unique rows',
  ORDER_BY: 'Sorted rows',
  LIMIT: 'Limited rows',
}

/** Socket label for an operation's secondary (branch) output. */
function branchSocketLabel(stage: VisualizedStage): string {
  if (stage === 'DISTINCT') return 'duplicates'
  if (stage === 'LIMIT') return 'offset'
  return 'rejected'
}

/**
 * Extra chrome (one 3px body gap + the preview table's border and header
 * row) revealed when a node's preview is expanded from zero rows.
 */
const EXPANDED_PREVIEW_CHROME = 19

/**
 * Preview expansion height, derived from the real number of rows shown.
 *
 * Source/data/final nodes already render three real rows when collapsed,
 * so they only grow by the additional rows. Branch nodes show just a
 * one-line hint when collapsed and reveal the whole preview table on
 * expansion, so their first rows need the table chrome as well.
 */
function expandedHeightFor(
  baseHeight: number,
  rowCount: number,
  collapsedRows: number = PREVIEW_ROWS,
): number | undefined {
  if (rowCount <= PREVIEW_ROWS) return undefined
  const shown = Math.min(rowCount, EXPANDED_ROWS)
  const chrome = collapsedRows === 0 ? EXPANDED_PREVIEW_CHROME : 0
  return baseHeight + chrome + (shown - collapsedRows) * EXPANDED_ROW_HEIGHT
}

interface SocketSpec {
  id: string
  direction: 'input' | 'output'
  kind: FlowSocketKind
  side: FlowSocketSide
  label?: string
}

/** Build a socket anchored to a deterministic offset on a node. */
function makeSocket(
  spec: SocketSpec,
  width: number,
  height: number,
  options: { x?: number; y?: number } = {},
): FlowSocket {
  const { side } = spec
  const x =
    options.x ??
    (side === 'left' ? 0 : side === 'right' ? width : width / 2)
  const y =
    options.y ??
    (side === 'top' ? 0 : side === 'bottom' ? height : height / 2)
  return { ...spec, x, y }
}

interface StageRow {
  opY: number
  dataY: number
  height: number
}

function branchLabel(stage: VisualizedStage, count: number): string {
  if (stage === 'DISTINCT') return `Duplicates (${count})`
  if (stage === 'LIMIT') return `Skipped by OFFSET (${count})`
  if (stage === 'HAVING') return `Rejected groups (${count})`
  return `Rejected rows (${count})`
}

function branchHint(stage: VisualizedStage): string {
  if (stage === 'DISTINCT') return 'These rows duplicated an earlier row.'
  if (stage === 'LIMIT') return 'These rows were skipped by OFFSET.'
  if (stage === 'HAVING') return 'These groups did not pass the condition.'
  return 'These rows did not pass the condition.'
}

function branchEdgeLabel(stage: VisualizedStage): string {
  if (stage === 'LIMIT') return 'offset'
  if (stage === 'DISTINCT') return 'duplicates'
  return 'rejected'
}

/**
 * Build the flow graph for a trace. Deterministic: the same trace
 * always yields the same nodes, sockets, edges and layout.
 */
export function buildFlowGraph(trace: VisualizationTrace): FlowGraph {
  const nodes: FlowGraphNode[] = []
  const edges: FlowGraphEdge[] = []
  const supportedStages = new Set(trace.capability.supportedStages)

  const snapshotByStage = new Map<VisualizedStage, StageSnapshot>()
  for (const snapshot of trace.stageSnapshots) snapshotByStage.set(snapshot.stage, snapshot)

  const pipelineStages = trace.stages.filter((stage) => stage !== 'FROM')

  // --- phase 1: pipeline row layout ---------------------------------------
  const rows = new Map<VisualizedStage, StageRow>()
  let rowTop = TOP
  for (const stage of pipelineStages) {
    const snapshot = snapshotByStage.get(stage)
    if (snapshot === undefined) continue
    const hasOp = OPERATION_STAGES.has(stage)
    const opY = rowTop
    const dataY = hasOp ? rowTop + OP_H + OP_DATA_GAP : rowTop
    const groupNodes =
      stage === 'GROUP_BY' && snapshot.groups.length > 0
        ? Math.min(snapshot.groups.length, MAX_GROUP_NODES) +
          (snapshot.groups.length > MAX_GROUP_NODES ? 1 : 0)
        : 0
    const sideExtent =
      groupNodes > 0
        ? 16 + groupNodes * (GROUP_H + GROUP_GAP)
        : snapshot.removedRows.length > 0
          ? OP_H + 24 + BRANCH_H
          : 0
    const spineExtent = (hasOp ? OP_H + OP_DATA_GAP : 0) + DATA_H
    const height = Math.max(spineExtent, sideExtent)
    rows.set(stage, { opY, dataY, height })
    rowTop += height + ROW_GAP
  }

  // --- phase 2: source tables, aligned with their consumer -----------------
  // A JOIN query's inputs all converge on the JOIN operation, so every
  // source is stacked beside it. Otherwise the FROM table sits beside
  // the first operation of the pipeline.
  const joinRow = rows.get('JOIN')
  const firstRow = pipelineStages[0] !== undefined ? rows.get(pipelineStages[0]) : undefined
  const consumerY = joinRow?.opY ?? firstRow?.opY ?? TOP
  const sourceCount = Math.max(trace.sourceTables.length, 0)
  const stackHeight =
    sourceCount > 0 ? sourceCount * SOURCE_H + (sourceCount - 1) * SOURCE_STACK_GAP : 0
  const stackTop = Math.max(16, consumerY + OP_H / 2 - stackHeight / 2)

  const sourceNodes: FlowGraphNode[] = trace.sourceTables.map((table, index) => {
    const height = SOURCE_H
    return {
      id: `src-${index}-${table.alias ?? table.name}`,
      kind: 'source',
      stage: table.role === 'from' ? 'FROM' : 'JOIN',
      label: table.name,
      detail:
        table.role === 'from'
          ? `${table.alias !== null ? `alias ${table.alias} · ` : ''}${table.rowCount} row${table.rowCount === 1 ? '' : 's'} in table`
          : `${table.joinType ?? 'JOIN'}${table.alias !== null ? ` · alias ${table.alias}` : ''} · ${table.rowCount} row${table.rowCount === 1 ? '' : 's'}`,
      hint: table.role === 'from' ? 'Data starts here.' : 'This table feeds the join.',
      x: SOURCE_X,
      y: stackTop + index * (SOURCE_H + SOURCE_STACK_GAP),
      width: SOURCE_W,
      height,
      sockets: [
        makeSocket(
          {
            id: 'out',
            direction: 'output',
            kind: 'data',
            side: 'right',
            label: table.alias ?? 'rows',
          },
          SOURCE_W,
          height,
        ),
      ],
      expandedHeight: expandedHeightFor(height, table.previewRows.length),
      // Source tables are query inputs, not query output: they already
      // exist in the database, so both join inputs are visible from the
      // start and visibly converge on the JOIN node.
      revealsAt: null,
      table,
    }
  })
  nodes.push(...sourceNodes)
  const mainSource = sourceNodes.find((node) => node.table?.role === 'from') ?? sourceNodes[0]
  const joinSources = sourceNodes.filter((node) => node.table?.role === 'join')

  // --- phase 3: operations, datasets, branches, groups ---------------------
  let previousBottom: FlowGraphNode | null = mainSource ?? null

  const addConnection = (
    from: FlowGraphNode,
    fromSocket: string,
    to: FlowGraphNode,
    toSocket: string,
    kind: FlowEdgeKind,
    stage: VisualizedStage | null,
    label?: string,
  ): void => {
    const curve = routeEdgeCurve(from, fromSocket, to, toSocket)
    if (curve.length < 4) return
    edges.push({
      id: `edge-${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      kind,
      stage,
      fromSocket,
      toSocket,
      label,
      curve,
      labelPoint: curveMidpoint(curve),
    })
  }

  for (const stage of pipelineStages) {
    const snapshot = snapshotByStage.get(stage)
    const row = rows.get(stage)
    if (snapshot === undefined || row === undefined) continue

    if (OPERATION_STAGES.has(stage)) {
      const hasBranch = BRANCH_STAGES.has(stage) && snapshot.removedRows.length > 0
      const hasGroups = stage === 'GROUP_BY' && snapshot.groups.length > 0

      // Inputs: a JOIN receives every source table laterally (Blender
      // style), while later spine operations receive the previous
      // dataset through a top port. A first operation reads its source
      // through a left port.
      const inputs: FlowSocket[] = []
      const inputBySourceId = new Map<string, string>()
      if (stage === 'JOIN') {
        const joinInputs = sourceNodes.filter(
          (source) => source === previousBottom || source.table?.role === 'join',
        )
        joinInputs.forEach((source, index) => {
          const id = `in-${index}`
          inputs.push(
            makeSocket(
              {
                id,
                direction: 'input',
                kind: 'data',
                side: 'left',
                label: source.table?.alias ?? 'table',
              },
              NODE_W,
              OP_H,
              { y: (OP_H * (index + 1)) / (joinInputs.length + 1) },
            ),
          )
          inputBySourceId.set(source.id, id)
        })
        if (previousBottom !== null && previousBottom.kind !== 'source') {
          inputs.push(
            makeSocket(
              { id: 'in', direction: 'input', kind: 'data', side: 'top', label: 'in' },
              NODE_W,
              OP_H,
            ),
          )
        }
      } else {
        const side: FlowSocketSide = previousBottom?.kind === 'source' ? 'left' : 'top'
        inputs.push(
          makeSocket(
            { id: 'in', direction: 'input', kind: 'data', side, label: 'in' },
            NODE_W,
            OP_H,
          ),
        )
      }

      // Outputs: the main dataset leaves through the bottom; branches
      // and group members leave through hollow right-hand ports.
      const outputs: FlowSocket[] = [
        makeSocket(
          { id: 'out', direction: 'output', kind: 'data', side: 'bottom', label: 'rows' },
          NODE_W,
          OP_H,
        ),
      ]
      const sideOutputs: FlowSocket[] = []
      if (hasBranch) {
        sideOutputs.push(
          makeSocket(
            {
              id: 'out-branch',
              direction: 'output',
              kind: 'branch',
              side: 'right',
              label: branchSocketLabel(stage),
            },
            NODE_W,
            OP_H,
          ),
        )
      }
      if (hasGroups) {
        sideOutputs.push(
          makeSocket(
            {
              id: 'out-groups',
              direction: 'output',
              kind: 'branch',
              side: 'right',
              label: 'groups',
            },
            NODE_W,
            OP_H,
          ),
        )
      }
      sideOutputs.forEach((socket, index) => {
        socket.y = (OP_H * (index + 1)) / (sideOutputs.length + 1)
        outputs.push(socket)
      })

      const opNode: FlowGraphNode = {
        id: `op-${stage}`,
        kind: 'operation',
        stage,
        label: stage.replace('_', ' '),
        detail: snapshot.label,
        hint: STAGE_HINTS[stage],
        x: SPINE_X,
        y: row.opY,
        width: NODE_W,
        height: OP_H,
        sockets: [...inputs, ...outputs],
        unsupported: supportedStages.has(stage) ? undefined : true,
        snapshot,
        revealsAt: null,
      }
      nodes.push(opNode)

      if (previousBottom !== null) {
        addConnection(
          previousBottom,
          'out',
          opNode,
          inputBySourceId.get(previousBottom.id) ?? inputs[0]?.id ?? 'in',
          'main',
          stage,
        )
      }

      // Every join table also feeds the JOIN operation from the left.
      if (stage === 'JOIN') {
        for (const source of joinSources) {
          addConnection(
            source,
            'out',
            opNode,
            inputBySourceId.get(source.id) ?? 'in',
            'join-input',
            stage,
          )
        }
      }
      previousBottom = opNode

      // Rejected/skipped rows branch to the right.
      if (hasBranch) {
        const branchNode: FlowGraphNode = {
          id: `branch-${stage}`,
          kind: 'branch',
          stage,
          label: branchLabel(stage, snapshot.removedRows.length),
          detail: snapshot.label,
          hint: branchHint(stage),
          x: SIDE_X,
          y: row.opY + OP_H + 24,
          width: SIDE_W,
          height: BRANCH_H,
          sockets: [
            makeSocket(
              { id: 'in', direction: 'input', kind: 'branch', side: 'left', label: 'in' },
              SIDE_W,
              BRANCH_H,
            ),
          ],
          expandedHeight: expandedHeightFor(BRANCH_H, snapshot.removedRows.length, 0),
          snapshot,
          removedRows: snapshot.removedRows,
          revealsAt: stage,
          isRejected: true,
        }
        nodes.push(branchNode)
        addConnection(
          opNode,
          'out-branch',
          branchNode,
          'in',
          'rejected',
          stage,
          branchEdgeLabel(stage),
        )
      }

      // GROUP BY fan-out: one node per real group, bounded with an
      // honest overflow node.
      if (hasGroups) {
        const shown = snapshot.groups.slice(0, MAX_GROUP_NODES)
        const groupSocket = opNode.sockets.find((socket) => socket.id === 'out-groups')
        shown.forEach((group, groupIndex) => {
          const groupNode: FlowGraphNode = {
            id: `group-${stage}-${group.index}`,
            kind: 'group',
            stage,
            label: group.key,
            detail: `${group.rowIds.length} row${group.rowIds.length === 1 ? '' : 's'} in group`,
            x: SIDE_X,
            y: row.opY + OP_H + 16 + groupIndex * (GROUP_H + GROUP_GAP),
            width: SIDE_W,
            height: GROUP_H,
            sockets: [
              makeSocket(
                { id: 'in', direction: 'input', kind: 'branch', side: 'left', label: 'in' },
                SIDE_W,
                GROUP_H,
              ),
            ],
            group,
            snapshot,
            revealsAt: stage,
          }
          nodes.push(groupNode)
          addConnection(opNode, groupSocket?.id ?? 'out-groups', groupNode, 'in', 'group-member', stage)
        })
        if (snapshot.groups.length > MAX_GROUP_NODES) {
          const overflowCount = snapshot.groups.length - MAX_GROUP_NODES
          const overflowNode: FlowGraphNode = {
            id: `group-${stage}-overflow`,
            kind: 'group',
            stage,
            label: `…+${overflowCount} more group${overflowCount === 1 ? '' : 's'}`,
            detail: 'All groups are listed in Table View',
            x: SIDE_X,
            y: row.opY + OP_H + 16 + MAX_GROUP_NODES * (GROUP_H + GROUP_GAP),
            width: SIDE_W,
            height: GROUP_H,
            sockets: [
              makeSocket(
                { id: 'in', direction: 'input', kind: 'branch', side: 'left', label: 'in' },
                SIDE_W,
                GROUP_H,
              ),
            ],
            revealsAt: stage,
          }
          nodes.push(overflowNode)
          addConnection(
            opNode,
            groupSocket?.id ?? 'out-groups',
            overflowNode,
            'in',
            'group-member',
            stage,
          )
        }
      }
    }

    const dataNode: FlowGraphNode = {
      id: `data-${stage}`,
      kind: 'data',
      stage,
      label: `${DATA_LABELS[stage] ?? `${stage} result`} · ${snapshot.outputRowCount}`,
      detail: `${snapshot.inputRowCount} in → ${snapshot.outputRowCount} out`,
      x: SPINE_X,
      y: row.dataY,
      width: NODE_W,
      height: DATA_H,
      sockets: [
        makeSocket(
          { id: 'in', direction: 'input', kind: 'data', side: 'top', label: 'in' },
          NODE_W,
          DATA_H,
        ),
        makeSocket(
          { id: 'out', direction: 'output', kind: 'data', side: 'bottom', label: 'rows' },
          NODE_W,
          DATA_H,
        ),
      ],
      expandedHeight: expandedHeightFor(DATA_H, snapshot.rows.length),
      unsupported: supportedStages.has(stage) ? undefined : true,
      snapshot,
      rows: snapshot.rows,
      revealsAt: stage,
    }
    nodes.push(dataNode)
    if (previousBottom !== null) {
      addConnection(previousBottom, 'out', dataNode, 'in', 'main', stage)
    }
    previousBottom = dataNode
  }

  // --- phase 4: final result -------------------------------------------------
  const finalNode: FlowGraphNode = {
    id: 'final',
    kind: 'final',
    stage: null,
    label: 'Final result',
    detail: `${trace.finalRows.length} row${trace.finalRows.length === 1 ? '' : 's'}${
      trace.capability.isReadOnly ? '' : ' · not read-only'
    }`,
    hint: 'These are the rows SQLite returns.',
    x: SPINE_X,
    y: rowTop,
    width: NODE_W,
    height: FINAL_H,
    sockets: [
      makeSocket(
        { id: 'in', direction: 'input', kind: 'data', side: 'top', label: 'in' },
        NODE_W,
        FINAL_H,
      ),
    ],
    expandedHeight: expandedHeightFor(FINAL_H, trace.finalRows.length),
    rows: trace.finalRows,
    snapshot: trace.stageSnapshots[trace.stageSnapshots.length - 1],
    revealsAt: lastStageOf(trace),
  }
  nodes.push(finalNode)
  if (previousBottom !== null) {
    addConnection(previousBottom, 'out', finalNode, 'in', 'final', lastStageOf(trace))
  }

  // Bounds come from the actual node extents so a query without branches
  // or groups gets a narrower (and therefore more readable) canvas. The
  // flow width covers only the main pipeline, letting narrow screens
  // start at a readable zoom with branch columns one pan away.
  const rightmost = nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0)
  const flowRightmost = nodes
    .filter((node) => node.kind !== 'branch' && node.kind !== 'group')
    .reduce((max, node) => Math.max(max, node.x + node.width), 0)
  const width = rightmost + 48
  // Bottom breathing room so the floating camera controls never cover
  // the final-result node when the view is scrolled to the end.
  const height = rowTop + FINAL_H + 96

  return {
    nodes,
    edges,
    bounds: { width, height, flowWidth: Math.min(width, flowRightmost + 28) },
  }
}

function lastStageOf(trace: VisualizationTrace): VisualizedStage | null {
  return trace.stages[trace.stages.length - 1] ?? null
}

/**
 * Derive per-node/per-edge playback status from the current view state.
 * Pure: same inputs always yield the same statuses.
 */
export function deriveFlowState(
  graph: FlowGraph,
  completedStages: ReadonlySet<VisualizedStage>,
  activeStage: VisualizedStage | null,
  finished: boolean,
): FlowGraphState {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nodes: Record<string, FlowElementStatus> = {}
  for (const node of graph.nodes) {
    if (node.kind === 'final') {
      // The final node is always visible as the destination; it only
      // counts as completed once its data actually exists.
      const lastStage = node.revealsAt
      nodes[node.id] =
        finished || (lastStage !== null && completedStages.has(lastStage)) ? 'completed' : 'pending'
      continue
    }
    if (node.revealsAt !== null && !completedStages.has(node.revealsAt)) {
      nodes[node.id] = 'hidden'
      continue
    }
    const owner = node.stage
    if (owner !== null && completedStages.has(owner)) {
      nodes[node.id] = 'completed'
    } else if (owner !== null && owner === activeStage && node.kind === 'operation') {
      nodes[node.id] = 'active'
    } else if (node.kind === 'source' && node.revealsAt === null) {
      nodes[node.id] = 'completed' // FROM table data is loaded before playback
    } else {
      nodes[node.id] = 'pending'
    }
  }

  const edges: Record<string, FlowElementStatus> = {}
  const packetEdgeIds: string[] = []
  for (const edge of graph.edges) {
    const target = byId.get(edge.to)
    const source = byId.get(edge.from)
    if (target === undefined || source === undefined) {
      edges[edge.id] = 'hidden'
      continue
    }
    if (nodes[target.id] === 'hidden' || nodes[source.id] === 'hidden') {
      edges[edge.id] = 'hidden'
      continue
    }
    const stage = edge.stage
    let status: FlowElementStatus
    if (stage !== null && completedStages.has(stage)) {
      status = 'completed'
    } else if (stage !== null && stage === activeStage) {
      status = 'active'
    } else {
      status = 'pending'
    }
    edges[edge.id] = status
    if (status === 'active') packetEdgeIds.push(edge.id)
  }

  return { nodes, edges, packetEdgeIds }
}

/** Groups actually available for inspection on a trace (all of them). */
export function allGroupsOfStage(snapshot: StageSnapshot): GroupSnapshot[] {
  return snapshot.groups
}
