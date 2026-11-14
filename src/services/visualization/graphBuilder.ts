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
 * and GROUP BY groups fan out to a right-hand column. Coordinates are
 * computed here so they are testable; rendering is separate.
 */

import type {
  FlowElementStatus,
  FlowGraph,
  FlowGraphEdge,
  FlowGraphNode,
  FlowGraphState,
} from '../../types/flowGraph'
import type {
  GroupSnapshot,
  StageSnapshot,
  VisualizationTrace,
  VisualizedStage,
} from '../../types/visualization'

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

// Layout constants: left source column → central pipeline spine → right
// branch column.
const SOURCE_X = 0
const SOURCE_W = 232
const SOURCE_H = 150
const SOURCE_STACK_GAP = 20
const SPINE_X = 320
const NODE_W = 248
const OP_H = 76
const DATA_H = 158
const OP_DATA_GAP = 26
const ROW_GAP = 34
const SIDE_X = 640
const SIDE_W = 224
const BRANCH_H = 74
const GROUP_H = 54
const GROUP_GAP = 12
const FINAL_H = 148
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

const centerY = (node: { y: number; height: number }): number => node.y + node.height / 2

/** Right-angle elbow route from a node's right edge to a target's left edge. */
function elbow(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): Array<{ x: number; y: number }> {
  const x1 = from.x + from.width
  const y1 = centerY(from)
  const x2 = to.x
  const y2 = centerY(to)
  if (Math.abs(y1 - y2) < 1) {
    return [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]
  }
  const midX = Math.round(x1 + Math.max((x2 - x1) * 0.55, 24))
  return [
    { x: x1, y: y1 },
    { x: midX, y: y1 },
    { x: midX, y: y2 },
    { x: x2, y: y2 },
  ]
}

/** Straight vertical connector (same column). */
function vertical(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): Array<{ x: number; y: number }> {
  const cx = from.x + from.width / 2
  return [
    { x: cx, y: from.y + from.height },
    { x: cx, y: to.y },
  ]
}

/** Point at the middle of a polyline, measured by arc length. */
function midpointOf(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0] ?? { x: 0, y: 0 }
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a === undefined || b === undefined) continue
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  let remaining = total / 2
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a === undefined || b === undefined) continue
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length
      return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio }
    }
    remaining -= length
  }
  return points[points.length - 1] ?? { x: 0, y: 0 }
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

interface StageRow {
  opY: number
  dataY: number
  height: number
}

/**
 * Build the flow graph for a trace. Deterministic: the same trace
 * always yields the same nodes, edges and layout.
 */
export function buildFlowGraph(trace: VisualizationTrace): FlowGraph {
  const nodes: FlowGraphNode[] = []
  const edges: FlowGraphEdge[] = []

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

  const sourceNodes: FlowGraphNode[] = trace.sourceTables.map((table, index) => ({
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
    height: SOURCE_H,
    table,
    // Source tables are query inputs, not query output: they already
    // exist in the database, so both join inputs are visible from the
    // start and visibly converge on the JOIN node.
    revealsAt: null,
  }))
  nodes.push(...sourceNodes)
  const mainSource = sourceNodes.find((node) => node.table?.role === 'from') ?? sourceNodes[0]
  const joinSources = sourceNodes.filter((node) => node.table?.role === 'join')

  // --- phase 3: operations, datasets, branches, groups ---------------------
  let previousBottom: FlowGraphNode | null = mainSource ?? null

  const addEdge = (
    edge: Omit<FlowGraphEdge, 'labelPoint'> & { labelPoint?: { x: number; y: number } },
  ): void => {
    edges.push({ ...edge, labelPoint: edge.labelPoint ?? midpointOf(edge.points) })
  }

  for (const stage of pipelineStages) {
    const snapshot = snapshotByStage.get(stage)
    const row = rows.get(stage)
    if (snapshot === undefined || row === undefined) continue

    if (OPERATION_STAGES.has(stage)) {
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
        snapshot,
        revealsAt: null,
      }
      nodes.push(opNode)
      if (previousBottom !== null) {
        const points = elbow(previousBottom, opNode)
        addEdge({
          id: `edge-${previousBottom.id}-${opNode.id}`,
          from: previousBottom.id,
          to: opNode.id,
          kind: 'main',
          stage,
          points,
        })
      }
      // Every join table also feeds the JOIN operation from the left.
      if (stage === 'JOIN') {
        for (const source of joinSources) {
          addEdge({
            id: `edge-${source.id}-${opNode.id}`,
            from: source.id,
            to: opNode.id,
            kind: 'join-input',
            stage,
            points: elbow(source, opNode),
          })
        }
      }
      previousBottom = opNode

      // Rejected/skipped rows branch to the right.
      if (BRANCH_STAGES.has(stage) && snapshot.removedRows.length > 0) {
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
          snapshot,
          removedRows: snapshot.removedRows,
          revealsAt: stage,
          isRejected: true,
        }
        nodes.push(branchNode)
        addEdge({
          id: `edge-${opNode.id}-${branchNode.id}`,
          from: opNode.id,
          to: branchNode.id,
          kind: 'rejected',
          label: stage === 'LIMIT' ? 'offset' : stage === 'DISTINCT' ? 'duplicates' : 'rejected',
          stage,
          points: elbow(opNode, branchNode),
        })
      }

      // GROUP BY fan-out: one node per real group, bounded with an
      // honest overflow node.
      if (stage === 'GROUP_BY' && snapshot.groups.length > 0) {
        const shown = snapshot.groups.slice(0, MAX_GROUP_NODES)
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
            group,
            snapshot,
            revealsAt: stage,
          }
          nodes.push(groupNode)
          addEdge({
            id: `edge-${opNode.id}-${groupNode.id}`,
            from: opNode.id,
            to: groupNode.id,
            kind: 'group-member',
            stage,
            points: elbow(opNode, groupNode),
          })
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
            revealsAt: stage,
          }
          nodes.push(overflowNode)
          addEdge({
            id: `edge-${opNode.id}-${overflowNode.id}`,
            from: opNode.id,
            to: overflowNode.id,
            kind: 'group-member',
            stage,
            points: elbow(opNode, overflowNode),
          })
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
      snapshot,
      rows: snapshot.rows,
      revealsAt: stage,
    }
    nodes.push(dataNode)
    const from = previousBottom
    addEdge({
      id: `edge-${from?.id ?? '?'}-${dataNode.id}`,
      from: from?.id ?? '',
      to: dataNode.id,
      kind: 'main',
      stage,
      points: from !== null ? vertical(from, dataNode) : [],
    })
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
    rows: trace.finalRows,
    snapshot: trace.stageSnapshots[trace.stageSnapshots.length - 1],
    revealsAt: lastStageOf(trace),
  }
  nodes.push(finalNode)
  if (previousBottom !== null) {
    addEdge({
      id: `edge-${previousBottom.id}-final`,
      from: previousBottom.id,
      to: finalNode.id,
      kind: 'final',
      stage: lastStageOf(trace),
      points: vertical(previousBottom, finalNode),
    })
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
