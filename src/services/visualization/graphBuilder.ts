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
  NestedQueryTrace,
  StageSnapshot,
  VisualizationTrace,
  VisualizedStage,
} from '../../types/visualization'
import { curveMidpoint, routeEdgeCurve } from './flowGeometry'
import { rootBlockIdOf, stageKeyFor } from './queryBlocks'

/** Operations that get a dedicated operation node (FROM is the source load). */
const OPERATION_STAGES = new Set<VisualizedStage>([
  'JOIN',
  'WHERE',
  'GROUP_BY',
  'HAVING',
  'SELECT',
  'DISTINCT',
  'COMPOUND',
  'ORDER_BY',
  'LIMIT',
])

/** Stages whose snapshot carries a rejected/skipped branch. */
const BRANCH_STAGES = new Set<VisualizedStage>(['WHERE', 'HAVING', 'DISTINCT', 'COMPOUND', 'LIMIT'])

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
  COMPOUND: 'Branch results are combined with UNION or UNION ALL.',
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
  COMPOUND: 'Compound rows',
  ORDER_BY: 'Sorted rows',
  LIMIT: 'Limited rows',
}

/** Socket label for an operation's secondary (branch) output. */
function branchSocketLabel(stage: VisualizedStage): string {
  if (stage === 'DISTINCT') return 'duplicates'
  if (stage === 'COMPOUND') return 'duplicates'
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
  if (stage === 'COMPOUND') return `Duplicates removed (${count})`
  if (stage === 'LIMIT') return `Skipped by OFFSET (${count})`
  if (stage === 'HAVING') return `Rejected groups (${count})`
  return `Rejected rows (${count})`
}

function branchHint(stage: VisualizedStage): string {
  if (stage === 'DISTINCT') return 'These rows duplicated an earlier row.'
  if (stage === 'COMPOUND') return 'UNION removed these rows because the compound result already contained them.'
  if (stage === 'LIMIT') return 'These rows were skipped by OFFSET.'
  if (stage === 'HAVING') return 'These groups did not pass the condition.'
  return 'These rows did not pass the condition.'
}

function branchEdgeLabel(stage: VisualizedStage): string {
  if (stage === 'LIMIT') return 'offset'
  if (stage === 'DISTINCT') return 'duplicates'
  if (stage === 'COMPOUND') return 'duplicates'
  return 'rejected'
}

/** Horizontal gap between nested-block columns. */
const NESTED_COLUMN_GAP = 56

interface NestedSubgraph {
  nodes: FlowGraphNode[]
  edges: FlowGraphEdge[]
  /** Last data node of each block (its real result, ready to be consumed). */
  lastByBlock: Map<string, FlowGraphNode>
  /** Width reserved for one nesting level. */
  columnWidth: number
}

/**
 * Build the stage-level subgraph of every nested query block.
 *
 * Nested results are computed before the outer pipeline, so their blocks
 * live in columns to the LEFT of the root pipeline: depth 1 next to the
 * sources, depth 2 one column further left-to-right, and so on. Each
 * node carries its block id and block-scoped stage key, so playback can
 * animate a block without ever touching another block's stages.
 *
 * Blocks are stacked vertically inside their depth column; coordinates
 * are deterministic for a given trace.
 */
function buildNestedSubgraphs(
  trace: VisualizationTrace,
  rootId: string,
  maxDepth: number,
): NestedSubgraph {
  const columnWidth = NODE_W + NESTED_COLUMN_GAP
  const nodes: FlowGraphNode[] = []
  const edges: FlowGraphEdge[] = []
  const lastByBlock = new Map<string, FlowGraphNode>()
  const columnTop = new Map<number, number>()

  const link = (
    from: FlowGraphNode,
    fromSocket: string,
    to: FlowGraphNode,
    toSocket: string,
    kind: FlowGraphEdge['kind'],
    stage: VisualizedStage,
    stageKey: string,
  ): void => {
    const curve = routeEdgeCurve(from, fromSocket, to, toSocket)
    if (curve.length < 4) return
    edges.push({
      id: `edge-${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      kind,
      stage,
      stageKey,
      fromSocket,
      toSocket,
      curve,
      labelPoint: curveMidpoint(curve),
    })
  }

  const blocks: NestedQueryTrace[] = trace.nestedQueries ?? []
  for (const block of blocks) {
    const depth = Math.max(1, block.depth ?? 1)
    // Depth 1 (the direct child) sits nearest the root pipeline; deeper
    // blocks stack further left so data visibly flows child → parent.
    const x = (maxDepth - depth) * columnWidth
    let rowTop = columnTop.get(depth) ?? TOP
    let previous: FlowGraphNode | null = null

    for (const snapshot of block.stageSnapshots) {
      const stage = snapshot.stage
      const hasOp = OPERATION_STAGES.has(stage)
      const stageKey = stageKeyFor(block.id, stage, rootId)
      let opNode: FlowGraphNode | null = null

      if (hasOp) {
        const inputSocket = makeSocket(
          {
            id: 'in',
            direction: 'input',
            kind: 'data',
            side: previous === null ? 'left' : 'top',
            label: 'in',
          },
          NODE_W,
          OP_H,
        )
        opNode = {
          id: `${block.id}-op-${stage}`,
          kind: 'operation',
          stage,
          blockId: block.id,
          stageKey,
          label: stage.replace('_', ' '),
          detail: snapshot.label,
          hint: STAGE_HINTS[stage],
          x,
          y: rowTop,
          width: NODE_W,
          height: OP_H,
          sockets: [
            inputSocket,
            makeSocket(
              { id: 'out', direction: 'output', kind: 'data', side: 'bottom', label: 'rows' },
              NODE_W,
              OP_H,
            ),
          ],
          snapshot,
          revealsAt: null,
          revealsAtKey: null,
          incomplete: block.incomplete === true,
          incompleteReasons: [...(block.incompleteReasons ?? [])],
        }
        nodes.push(opNode)
        if (previous !== null) {
          link(previous, 'out', opNode, inputSocket.id, 'main', stage, stageKey)
        }
        previous = opNode
      }

      const dataNode: FlowGraphNode = {
        id: `${block.id}-data-${stage}`,
        kind: 'data',
        stage,
        blockId: block.id,
        stageKey,
        label: `${DATA_LABELS[stage] ?? `${stage} result`} · ${snapshot.outputRowCount}`,
        detail: `${snapshot.inputRowCount} in → ${snapshot.outputRowCount} out`,
        x,
        y: hasOp ? rowTop + OP_H + OP_DATA_GAP : rowTop,
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
        snapshot,
        rows: snapshot.rows,
        revealsAt: stage,
        revealsAtKey: stageKey,
        incomplete: block.incomplete === true,
        incompleteReasons: [...(block.incompleteReasons ?? [])],
      }
      nodes.push(dataNode)
      if (previous !== null) {
        link(previous, 'out', dataNode, 'in', 'main', stage, stageKey)
      }
      previous = dataNode
      rowTop += (hasOp ? OP_H + OP_DATA_GAP : 0) + DATA_H + ROW_GAP
    }

    if (previous !== null) lastByBlock.set(block.id, previous)
    columnTop.set(depth, rowTop)
  }

  return { nodes, edges, lastByBlock, columnWidth }
}

/**
 * Build the flow graph for a trace. Deterministic: the same trace
 * always yields the same nodes, sockets, edges and layout.
 */
export function buildFlowGraph(trace: VisualizationTrace): FlowGraph {
  const nodes: FlowGraphNode[] = []
  const edges: FlowGraphEdge[] = []
  const supportedStages = new Set(trace.capability.supportedStages)
  const rootId = rootBlockIdOf(trace)

  // Nested blocks are rendered in columns to the left of the root
  // pipeline. Only queries with nested blocks pay the layout shift, so a
  // single-block query keeps exactly the same coordinates as before.
  const nestedBlocks = trace.nestedQueries ?? []
  const compoundBranches = trace.compound?.branches ?? []
  const nestedMaxDepth = nestedBlocks.reduce(
    (max, block) => Math.max(max, Math.max(1, block.depth ?? 1)),
    0,
  )
  const nested = buildNestedSubgraphs(trace, rootId, nestedMaxDepth)
  const rootShift = nested.nodes.length > 0 ? nestedMaxDepth * nested.columnWidth : 0
  const sourceX = SOURCE_X + rootShift
  const spineX = SPINE_X + rootShift
  const sideX = SIDE_X + rootShift

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
    // Side columns start below the operation node, so their extent must
    // include OP_H + the 16px gap before the first branch/group.
    const sideExtent =
      groupNodes > 0
        ? OP_H + 16 + groupNodes * GROUP_H + Math.max(0, groupNodes - 1) * GROUP_GAP
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
  const primarySources = trace.sourceTables.filter(
    (table) => table.role !== 'subquery' && table.role !== 'cte',
  )
  const sourceCount = primarySources.length
  const stackHeight =
    sourceCount > 0 ? sourceCount * SOURCE_H + (sourceCount - 1) * SOURCE_STACK_GAP : 0
  const stackTop = Math.max(16, consumerY + OP_H / 2 - stackHeight / 2)
  // Nested query results are inputs too, but they are computed before the
  // outer pipeline. They stack below the real tables so no node overlaps,
  // and their wires still point at the consuming operation.
  const nestedStackTop =
    sourceCount > 0
      ? stackTop + stackHeight + SOURCE_STACK_GAP
      : Math.max(16, consumerY + OP_H / 2 - SOURCE_H / 2)
  let nestedPosition = 0

  const sourceNodes: FlowGraphNode[] = trace.sourceTables.map((table, index) => {
    const height = SOURCE_H
    const isPrimary = table.role !== 'subquery' && table.role !== 'cte'
    const primaryIndex = primarySources.indexOf(table)
    const y = isPrimary
      ? stackTop + primaryIndex * (SOURCE_H + SOURCE_STACK_GAP)
      : nestedStackTop + nestedPosition++ * (SOURCE_H + SOURCE_STACK_GAP)
    const isCte = table.role === 'cte'
    const detail = isPrimary
      ? table.role === 'from'
        ? `${table.alias !== null ? `alias ${table.alias} · ` : ''}${table.rowCount} row${table.rowCount === 1 ? '' : 's'} in table`
        : `${table.joinType ?? 'JOIN'}${table.alias !== null ? ` · alias ${table.alias}` : ''} · ${table.rowCount} row${table.rowCount === 1 ? '' : 's'}`
      : isCte
        ? `CTE result · ${table.rowCount} row${table.rowCount === 1 ? '' : 's'}`
        : `Nested query result · ${table.rowCount} row${table.rowCount === 1 ? '' : 's'}`
    const hint = isPrimary
      ? table.role === 'from'
        ? 'Data starts here.'
        : 'This table feeds the join.'
      : isCte
        ? 'The CTE is computed before this query reads it.'
        : 'This subquery is evaluated before the outer pipeline runs.'
    const nodeStage: VisualizedStage = isPrimary
      ? table.role === 'from'
        ? 'FROM'
        : 'JOIN'
      : (table.consumerStage ?? 'SELECT')
    const sockets: FlowSocket[] = []
    // A nested/CTE result is produced by its own subgraph; that subgraph
    // feeds this source node through a dedicated input port.
    if (!isPrimary) {
      sockets.push(
        makeSocket(
          { id: 'in-nested', direction: 'input', kind: 'data', side: 'left', label: 'rows' },
          SOURCE_W,
          height,
        ),
      )
    }
    sockets.push(
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
    )
    return {
      id: `src-${index}-${table.alias ?? table.name}`,
      kind: 'source',
      stage: nodeStage,
      blockId: rootId,
      stageKey: stageKeyFor(rootId, nodeStage, rootId),
      label: table.name,
      detail,
      hint,
      x: sourceX,
      y,
      width: SOURCE_W,
      height,
      sockets,
      expandedHeight: expandedHeightFor(height, table.previewRows.length),
      // Source tables are query inputs, not query output: they already
      // exist in the database, so both join inputs are visible from the
      // start and visibly converge on the JOIN node.
      revealsAt: null,
      table,
      incomplete: table.incomplete === true,
      incompleteReasons: [...(table.incompleteReasons ?? [])],
    }
  })
  nodes.push(...sourceNodes)
  const mainSource = sourceNodes.find((node) => node.table?.role === 'from') ?? sourceNodes[0]
  const joinSources = sourceNodes.filter((node) => node.table?.role === 'join')
  const subquerySources = sourceNodes.filter(
    (node) => node.table?.role === 'subquery' || node.table?.role === 'cte',
  )

  // --- phase 2b: nested query subgraphs ------------------------------------
  // Every nested block gets its own stage-level subgraph on the left. Its
  // last data node is the block's real result and feeds the matching
  // source node (role: 'subquery' / 'cte'), which then feeds the
  // consuming stage. Nothing is wired across blocks by name, only by
  // recorded block ids and dependency edges.
  nodes.push(...nested.nodes)
  edges.push(...nested.edges)
  for (const source of subquerySources) {
    const blockId = source.table?.queryId
    if (blockId === undefined) continue
    const last = nested.lastByBlock.get(blockId)
    if (last === undefined) continue
    const input = source.sockets.find((socket) => socket.id === 'in-nested')
    if (input === undefined) continue
    const curve = routeEdgeCurve(last, 'out', source, input.id)
    if (curve.length < 4) continue
    const block = nestedBlocks.find((entry) => entry.id === blockId)
    const lastStage = block?.stageSnapshots[block.stageSnapshots.length - 1]?.stage ?? null
    edges.push({
      id: `edge-${last.id}-${source.id}`,
      from: last.id,
      to: source.id,
      kind: source.table?.role === 'cte' ? 'cte' : 'main',
      stage: lastStage,
      stageKey: lastStage !== null ? stageKeyFor(blockId, lastStage, rootId) : null,
      fromSocket: 'out',
      toSocket: input.id,
      curve,
      labelPoint: curveMidpoint(curve),
    })
  }

  // A CTE that reads an earlier CTE gets an explicit edge between the two
  // block subgraphs. The target is the exact stage that consumes the
  // rows (FROM data or JOIN operation), never a stage-name guess.
  for (const block of nestedBlocks) {
    for (const dependency of block.dependencies ?? []) {
      const from = nested.lastByBlock.get(dependency.blockId)
      if (from === undefined) continue
      const targetId =
        dependency.stage === 'FROM'
          ? `${block.id}-data-FROM`
          : `${block.id}-op-${dependency.stage}`
      const target =
        nodes.find((node) => node.id === targetId) ??
        nodes.find((node) => node.blockId === block.id)
      if (target === undefined) continue
      const input = target.sockets.find((socket) => socket.direction === 'input')
      if (input === undefined) continue
      const curve = routeEdgeCurve(from, 'out', target, input.id)
      if (curve.length < 4) continue
      const dependencyBlock = nestedBlocks.find((entry) => entry.id === dependency.blockId)
      const lastStage =
        dependencyBlock?.stageSnapshots[dependencyBlock.stageSnapshots.length - 1]?.stage ?? null
      edges.push({
        id: `edge-${from.id}-${target.id}`,
        from: from.id,
        to: target.id,
        kind: 'cte',
        label: 'cte',
        stage: lastStage,
        stageKey: lastStage !== null ? stageKeyFor(dependency.blockId, lastStage, rootId) : null,
        fromSocket: 'out',
        toSocket: input.id,
        curve,
        labelPoint: curveMidpoint(curve),
      })
    }
  }

  // --- phase 3: operations, datasets, branches, groups ---------------------
  let previousBottom: FlowGraphNode | null = mainSource ?? null
  const compoundInputByBranch = new Map<string, string>()

  const addConnection = (
    from: FlowGraphNode,
    fromSocket: string,
    to: FlowGraphNode,
    toSocket: string,
    kind: FlowEdgeKind,
    stage: VisualizedStage | null,
    label?: string,
    stageKeyOverride?: string | null,
  ): void => {
    const curve = routeEdgeCurve(from, fromSocket, to, toSocket)
    if (curve.length < 4) return
    edges.push({
      id: `edge-${from.id}-${to.id}`,
      from: from.id,
      to: to.id,
      kind,
      stage,
      stageKey:
        stageKeyOverride !== undefined
          ? stageKeyOverride
          : stage !== null
            ? stageKeyFor(rootId, stage, rootId)
            : null,
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
      const stageSubquerySources = subquerySources.filter(
        (source) => (source.table?.consumerStage ?? null) === stage,
      )
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
      } else if (stage === 'COMPOUND' && compoundBranches.length > 0) {
        // A compound operation has one real input per SELECT branch. Each
        // branch subgraph ends in a data node that feeds its own port.
        compoundBranches.forEach((branch, index) => {
          const id = `in-branch-${index}`
          inputs.push(
            makeSocket(
              {
                id,
                direction: 'input',
                kind: 'data',
                side: 'left',
                label: `branch ${index + 1}`,
              },
              NODE_W,
              OP_H,
              { y: (OP_H * (index + 1)) / (compoundBranches.length + 1) },
            ),
          )
          compoundInputByBranch.set(branch.blockId, id)
        })
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

      // A nested result is a second real input to the operation whose
      // expression consumes it (WHERE, SELECT, JOIN …). It gets its own
      // left port so the wire does not merge with the main dataset.
      stageSubquerySources.forEach((source, index) => {
        const id = `in-sub-${index}`
        inputs.push(
          makeSocket(
            {
              id,
              direction: 'input',
              kind: 'data',
              side: 'left',
              label: source.table?.alias ?? 'value',
            },
            NODE_W,
            OP_H,
            { y: (OP_H * (index + 2)) / (stageSubquerySources.length + 2) },
          ),
        )
        inputBySourceId.set(source.id, id)
      })

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
        blockId: rootId,
        stageKey: stageKeyFor(rootId, stage, rootId),
        label: stage.replace('_', ' '),
        detail: snapshot.label,
        hint: STAGE_HINTS[stage],
        x: spineX,
        y: row.opY,
        width: NODE_W,
        height: OP_H,
        sockets: [...inputs, ...outputs],
        unsupported: supportedStages.has(stage) ? undefined : true,
        snapshot,
        revealsAt: null,
        revealsAtKey: null,
        incomplete: snapshot.incomplete === true,
        incompleteReasons: [...(snapshot.incompleteReasons ?? [])],
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

      // Nested results feed exactly the operation whose expression uses
      // them, and no other stage.
      for (const source of stageSubquerySources) {
        addConnection(
          source,
          'out',
          opNode,
          inputBySourceId.get(source.id) ?? 'in',
          source.table?.role === 'cte' ? 'cte' : 'join-input',
          stage,
          source.table?.role === 'cte' ? 'cte' : 'value',
        )
      }
      // Branch results feed the shared COMPOUND operation, each through its
      // own port. The edge becomes active when that branch finishes, and
      // upstream tracing therefore follows the exact branch subgraph.
      if (stage === 'COMPOUND') {
        for (const branch of compoundBranches) {
          const from = nested.lastByBlock.get(branch.blockId)
          const socket = compoundInputByBranch.get(branch.blockId)
          if (from === undefined || socket === undefined) continue
          const branchBlock = nestedBlocks.find((block) => block.id === branch.blockId)
          const lastStage =
            branchBlock?.stageSnapshots[branchBlock.stageSnapshots.length - 1]?.stage ?? null
          addConnection(
            from,
            'out',
            opNode,
            socket,
            'compound',
            lastStage,
            branch.operator ?? 'UNION',
            lastStage !== null ? stageKeyFor(branch.blockId, lastStage, rootId) : null,
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
          blockId: rootId,
          stageKey: stageKeyFor(rootId, stage, rootId),
          label: branchLabel(stage, snapshot.removedRows.length),
          detail: snapshot.label,
          hint: branchHint(stage),
          x: sideX,
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
          revealsAtKey: stageKeyFor(rootId, stage, rootId),
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
            blockId: rootId,
            stageKey: stageKeyFor(rootId, stage, rootId),
            label: group.key,
            detail: `${group.rowIds.length} row${group.rowIds.length === 1 ? '' : 's'} in group`,
            x: sideX,
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
            revealsAtKey: stageKeyFor(rootId, stage, rootId),
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
            blockId: rootId,
            stageKey: stageKeyFor(rootId, stage, rootId),
            label: `…+${overflowCount} more group${overflowCount === 1 ? '' : 's'}`,
            detail: 'All groups are listed in Table View',
            x: sideX,
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
            revealsAtKey: stageKeyFor(rootId, stage, rootId),
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
      blockId: rootId,
      stageKey: stageKeyFor(rootId, stage, rootId),
      label: `${DATA_LABELS[stage] ?? `${stage} result`} · ${snapshot.outputRowCount}`,
      detail: `${snapshot.inputRowCount} in → ${snapshot.outputRowCount} out`,
      x: spineX,
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
      revealsAtKey: stageKeyFor(rootId, stage, rootId),
      incomplete: snapshot.incomplete === true,
      incompleteReasons: [...(snapshot.incompleteReasons ?? [])],
    }
    nodes.push(dataNode)
    if (previousBottom !== null) {
      addConnection(previousBottom, 'out', dataNode, 'in', 'main', stage)
    }
    previousBottom = dataNode
  }

  // --- phase 4: final result -------------------------------------------------
  const finalStage = lastStageOf(trace)
  const finalNode: FlowGraphNode = {
    id: 'final',
    kind: 'final',
    stage: null,
    label: 'Final result',
    detail: `${trace.finalRows.length} row${trace.finalRows.length === 1 ? '' : 's'}${
      trace.capability.isReadOnly ? '' : ' · not read-only'
    }`,
    hint: 'These are the rows SQLite returns.',
    x: spineX,
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
    revealsAt: finalStage,
    revealsAtKey: finalStage !== null ? stageKeyFor(rootId, finalStage, rootId) : null,
    blockId: rootId,
    stageKey: null,
  }
  nodes.push(finalNode)
  if (previousBottom !== null) {
    addConnection(previousBottom, 'out', finalNode, 'in', 'final', lastStageOf(trace))
  }

  // Bounds come from the actual node extents so a query without branches
  // or groups gets a narrower (and therefore more readable) canvas, while
  // tall source stacks and group fan-outs are never clipped. The flow
  // width covers only the main pipeline, letting narrow screens start at
  // a readable zoom with branch columns one pan away.
  const rightmost = nodes.reduce((max, node) => Math.max(max, node.x + node.width), 0)
  const bottommost = nodes.reduce((max, node) => Math.max(max, node.y + node.height), 0)
  const flowRightmost = nodes
    .filter((node) => node.kind !== 'branch' && node.kind !== 'group')
    .reduce((max, node) => Math.max(max, node.x + node.width), 0)
  const width = rightmost + 48
  // Bottom breathing room so the floating camera controls never cover
  // the final-result node when the view is scrolled to the end.
  const height = Math.max(rowTop + FINAL_H + 96, bottommost + 48)

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
  completedStages: ReadonlySet<string>,
  activeStage: string | null,
  finished: boolean,
): FlowGraphState {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const nodes: Record<string, FlowElementStatus> = {}
  for (const node of graph.nodes) {
    // Block-scoped keys keep the same stage name in two blocks distinct.
    // Root nodes fall back to their bare stage, so single-query graphs
    // behave exactly as before.
    const revealsKey = node.revealsAtKey ?? node.revealsAt
    const ownerKey = node.stageKey ?? node.stage
    if (node.kind === 'final') {
      // The final node is always visible as the destination; it only
      // counts as completed once its data actually exists.
      nodes[node.id] =
        finished || (revealsKey !== null && completedStages.has(revealsKey))
          ? 'completed'
          : 'pending'
      continue
    }
    if (revealsKey !== null && !completedStages.has(revealsKey)) {
      nodes[node.id] = 'hidden'
      continue
    }
    if (ownerKey !== null && completedStages.has(ownerKey)) {
      nodes[node.id] = 'completed'
    } else if (ownerKey !== null && ownerKey === activeStage && node.kind === 'operation') {
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
    const stageKey = edge.stageKey ?? edge.stage
    let status: FlowElementStatus
    if (stageKey !== null && completedStages.has(stageKey)) {
      status = 'completed'
    } else if (stageKey !== null && stageKey === activeStage) {
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
