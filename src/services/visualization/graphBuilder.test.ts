import { describe, expect, it } from 'vitest'
import type {
  StageSnapshot,
  TraceSourceTable,
  VisualizationEvent,
  VisualizationTrace,
} from '../../types/visualization'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { socketPoint } from './flowGeometry'

/**
 * Flow-graph builder tests: nodes must come from real trace data,
 * edges from real data dependencies, and playback state derivation
 * must never reveal data before its stage completed.
 */

function sourceTable(
  name: string,
  role: 'from' | 'join',
  rowCount: number,
  joinType: TraceSourceTable['joinType'] = null,
): TraceSourceTable {
  return {
    name,
    alias: role === 'from' ? 'e' : name === 'departments' ? 'd' : null,
    columns: ['id', 'name'],
    rowCount,
    previewRows: Array.from({ length: Math.min(rowCount, 3) }, (_, index) => ({
      id: `${name}#${index + 1}`,
      values: [index + 1, `${name} row`],
    })),
    role,
    joinType,
    on: role === 'join' ? 'e.department_id = d.id' : null,
  }
}

function snapshot(
  stage: StageSnapshot['stage'],
  rowCount: number,
  removedCount = 0,
  groups: StageSnapshot['groups'] = [],
): StageSnapshot {
  return {
    stage,
    label: `${stage} demo`,
    columns: ['name'],
    rows: Array.from({ length: rowCount }, (_, index) => ({ id: `r${index + 1}`, values: [index + 1] })),
    removedRows: Array.from({ length: removedCount }, (_, index) => ({
      id: `x${index + 1}`,
      values: [index + 1],
    })),
    roles: {},
    groups,
    explanation: `${stage}`,
    inputRowCount: rowCount + removedCount,
    outputRowCount: rowCount,
    truncated: false,
  }
}

function groupSnapshot(index: number, memberCount: number): StageSnapshot['groups'][number] {
  return {
    index,
    key: `department_id = ${index}`,
    keyValues: [index],
    rowIds: Array.from({ length: memberCount }, (_, i) => `r${i + 1}`),
    aggregates: { 'COUNT(*)': memberCount },
  }
}

function makeTrace(overrides: Partial<VisualizationTrace> = {}): VisualizationTrace {
  const stages: VisualizationTrace['stages'] = ['FROM', 'WHERE', 'SELECT']
  const events: VisualizationEvent[] = stages.map((stage, index) => ({
    id: `evt${index + 1}`,
    type: 'STAGE_COMPLETED',
    description: stage,
    stage,
  }))
  return {
    query: 'SELECT name FROM employees WHERE salary > 50000',
    statementType: 'SELECT',
    capability: {
      supported: true,
      supportedStages: stages,
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: false,
      hasJoin: false,
      estimatedComplexity: 'small',
    },
    stages,
    events,
    stageSnapshots: [snapshot('FROM', 8), snapshot('WHERE', 4, 4), snapshot('SELECT', 4)],
    sourceTables: [sourceTable('employees', 'from', 8)],
    totalSteps: events.length,
    finalRows: [{ id: 'r1', values: ['A'] }],
    finalColumns: ['name'],
    hasDeterministicOrder: false,
    truncated: false,
    ...overrides,
  }
}

describe('buildFlowGraph — basic pipeline', () => {
  it('creates a source node from the real FROM table', () => {
    const graph = buildFlowGraph(makeTrace())
    const source = graph.nodes.find((node) => node.kind === 'source')
    expect(source).toBeDefined()
    expect(source?.table?.name).toBe('employees')
    expect(source?.table?.rowCount).toBe(8)
    expect(source?.table?.previewRows).toHaveLength(3)
    expect(source?.label).toBe('employees') // the real table name
    expect(source?.detail).toContain('alias e')
  })

  it('creates one operation per non-FROM stage and one data node per non-terminal stage', () => {
    const graph = buildFlowGraph(makeTrace())
    const ops = graph.nodes.filter((node) => node.kind === 'operation').map((node) => node.stage)
    const data = graph.nodes.filter((node) => node.kind === 'data').map((node) => node.stage)
    expect(ops).toEqual(['WHERE', 'SELECT'])
    // The terminal stage's rows are the result itself, so it feeds the final
    // node instead of creating a second, identical data node.
    expect(data).toEqual(['WHERE'])
    expect(graph.nodes.filter((node) => node.kind === 'final')).toHaveLength(1)
    expect(graph.nodes.some((node) => node.id === 'data-SELECT')).toBe(false)
  })

  it('chains edges along the real data dependency', () => {
    const graph = buildFlowGraph(makeTrace())
    const ids = new Set(graph.nodes.map((node) => node.id))
    for (const edge of graph.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
    const sourceToWhere = graph.edges.find((edge) => edge.to === 'op-WHERE')
    expect(sourceToWhere?.from).toMatch(/^src-/)
    expect(sourceToWhere?.stage).toBe('WHERE')
    const selectToFinal = graph.edges.find((edge) => edge.to === 'final')
    expect(selectToFinal?.from).toBe('op-SELECT')
  })

  it('WHERE creates a rejected branch with the real removed count', () => {
    const graph = buildFlowGraph(makeTrace())
    const branch = graph.nodes.find((node) => node.kind === 'branch')
    expect(branch).toBeDefined()
    expect(branch?.label).toContain('Rejected rows (4)')
    expect(branch?.removedRows).toHaveLength(4)
    expect(branch?.isRejected).toBe(true)
    // Its edge comes from the WHERE operation with kind 'rejected'.
    const edge = graph.edges.find((candidate) => candidate.kind === 'rejected')
    expect(edge?.from).toBe('op-WHERE')
    expect(edge?.to).toBe(branch?.id)
  })

  it('stages without removed rows produce no branch node', () => {
    const graph = buildFlowGraph(makeTrace({ stageSnapshots: [snapshot('FROM', 8), snapshot('WHERE', 8, 0), snapshot('SELECT', 8)] }))
    expect(graph.nodes.filter((node) => node.kind === 'branch')).toHaveLength(0)
  })

  it('is deterministic for the same trace', () => {
    const trace = makeTrace()
    const a = buildFlowGraph(trace)
    const b = buildFlowGraph(trace)
    expect(a).toEqual(b)
  })

  it('produces sane layout bounds', () => {
    const graph = buildFlowGraph(makeTrace())
    expect(graph.bounds.width).toBeGreaterThan(0)
    expect(graph.bounds.height).toBeGreaterThan(0)
    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.x + node.width).toBeLessThanOrEqual(graph.bounds.width)
      expect(node.y + node.height).toBeLessThanOrEqual(graph.bounds.height)
    }
  })
})

describe('buildFlowGraph — JOIN merging', () => {
  const joinTrace = makeTrace({
    stages: ['FROM', 'JOIN', 'SELECT'],
    sourceTables: [sourceTable('employees', 'from', 8), sourceTable('departments', 'join', 3, 'INNER JOIN')],
    stageSnapshots: [snapshot('FROM', 8), snapshot('JOIN', 8), snapshot('SELECT', 8)],
    capability: {
      supported: true,
      supportedStages: ['FROM', 'JOIN', 'SELECT'],
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: false,
      hasJoin: true,
      estimatedComplexity: 'small',
    },
  })

  it('both source tables merge into the JOIN operation', () => {
    const graph = buildFlowGraph(joinTrace)
    const joinInputs = graph.edges.filter(
      (edge) => edge.to === 'op-JOIN' && (edge.kind === 'join-input' || edge.from.startsWith('src-')),
    )
    expect(joinInputs).toHaveLength(2)
    const joinInputSources = joinInputs.map((edge) => edge.from).sort()
    expect(joinInputSources).toHaveLength(2)
    expect(graph.nodes.filter((node) => node.kind === 'source')).toHaveLength(2)
  })

  it('join source nodes are visible from the start as query inputs', () => {
    const graph = buildFlowGraph(joinTrace)
    const joinSource = graph.nodes.find((node) => node.kind === 'source' && node.table?.role === 'join')
    expect(joinSource?.revealsAt).toBeNull()
    expect(joinSource?.table?.rowCount).toBe(3)
  })
})

describe('buildFlowGraph — GROUP BY fan-out', () => {
  const groups = [
    groupSnapshot(1, 3),
    groupSnapshot(2, 3),
    groupSnapshot(3, 2),
  ]
  const groupTrace = makeTrace({
    stages: ['FROM', 'GROUP_BY', 'SELECT'],
    stageSnapshots: [snapshot('FROM', 8), snapshot('GROUP_BY', 3, 0, groups), snapshot('SELECT', 3)],
    capability: {
      supported: true,
      supportedStages: ['FROM', 'GROUP_BY', 'SELECT'],
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: true,
      hasJoin: false,
      estimatedComplexity: 'small',
    },
  })

  it('creates one group node per real group, connected to the GROUP BY operation', () => {
    const graph = buildFlowGraph(groupTrace)
    const groupNodes = graph.nodes.filter((node) => node.kind === 'group')
    expect(groupNodes).toHaveLength(3)
    expect(groupNodes.map((node) => node.group?.key)).toEqual(groups.map((group) => group.key))
    for (const node of groupNodes) {
      const edge = graph.edges.find((candidate) => candidate.to === node.id)
      expect(edge?.from).toBe('op-GROUP_BY')
      expect(edge?.kind).toBe('group-member')
    }
  })

  it('caps group nodes honestly and reports the overflow count', () => {
    const manyGroups = Array.from({ length: 11 }, (_, index) => groupSnapshot(index + 1, 1))
    const graph = buildFlowGraph(
      makeTrace({
        stages: ['FROM', 'GROUP_BY', 'SELECT'],
        stageSnapshots: [snapshot('FROM', 11), snapshot('GROUP_BY', 11, 0, manyGroups), snapshot('SELECT', 11)],
      }),
    )
    const groupNodes = graph.nodes.filter((node) => node.kind === 'group')
    expect(groupNodes).toHaveLength(9) // 8 + overflow note
    const overflow = groupNodes.find((node) => node.group === undefined)
    expect(overflow?.label).toContain('+3 more groups')
  })

  it('reserves vertical room for the full group fan-out before the next stage', () => {
    const graph = buildFlowGraph(groupTrace)
    const groupNodes = graph.nodes.filter((node) => node.kind === 'group')
    const groupBottom = Math.max(...groupNodes.map((node) => node.y + node.height))
    const nextOp = graph.nodes.find((node) => node.id === 'op-SELECT')!
    // The next pipeline row starts below every real group node, so a
    // fan-out can never collide with the following stage.
    expect(nextOp.y).toBeGreaterThan(groupBottom)
    for (const node of groupNodes) {
      expect(node.y + node.height).toBeLessThanOrEqual(graph.bounds.height)
    }
  })
})

describe('buildFlowGraph — layout quality', () => {
  it('aligns source tables with the operation that consumes them', () => {
    const joinTrace = makeTrace({
      stages: ['FROM', 'JOIN', 'SELECT'],
      sourceTables: [sourceTable('employees', 'from', 8), sourceTable('departments', 'join', 3, 'INNER JOIN')],
      stageSnapshots: [snapshot('FROM', 8), snapshot('JOIN', 8), snapshot('SELECT', 8)],
    })
    const graph = buildFlowGraph(joinTrace)
    const joinOp = graph.nodes.find((node) => node.id === 'op-JOIN')!
    for (const source of graph.nodes.filter((node) => node.kind === 'source')) {
      const sourceCenter = source.y + source.height / 2
      const opCenter = joinOp.y + joinOp.height / 2
      // Sources are stacked around the JOIN operation's center, so the
      // two input paths visibly converge on it.
      expect(Math.abs(sourceCenter - opCenter)).toBeLessThanOrEqual(260)
    }
  })

  it('expands canvas bounds to include a tall source stack', () => {
    const tables = [
      sourceTable('employees', 'from', 8),
      ...Array.from({ length: 5 }, (_, index) =>
        sourceTable(`lookup_${index}`, 'join', 2, 'INNER JOIN'),
      ),
    ]
    const graph = buildFlowGraph(
      makeTrace({
        stages: ['FROM', 'JOIN', 'SELECT'],
        sourceTables: tables,
        stageSnapshots: [snapshot('FROM', 8), snapshot('JOIN', 8), snapshot('SELECT', 8)],
      }),
    )
    const sourceBottom = Math.max(
      ...graph.nodes
        .filter((node) => node.kind === 'source')
        .map((node) => node.y + node.height),
    )
    // Six real source tables are taller than the pipeline itself, so the
    // canvas must grow to contain them rather than clipping the inputs.
    expect(sourceBottom).toBeGreaterThan(graph.nodes.find((node) => node.id === 'final')!.y)
    for (const node of graph.nodes) {
      expect(node.y + node.height).toBeLessThanOrEqual(graph.bounds.height)
    }
  })

  it('operation nodes carry their real snapshot and a beginner hint', () => {
    const graph = buildFlowGraph(makeTrace())
    const where = graph.nodes.find((node) => node.id === 'op-WHERE')!
    expect(where.snapshot?.stage).toBe('WHERE')
    expect(where.snapshot?.outputRowCount).toBe(4)
    expect(where.hint).toContain('condition')
  })

  it('data and final nodes carry honest stage-specific labels and counts', () => {
    const graph = buildFlowGraph(makeTrace())
    const dataWhere = graph.nodes.find((node) => node.id === 'data-WHERE')!
    expect(dataWhere.label).toBe('Filtered rows · 4')
    expect(dataWhere.detail).toBe('8 in → 4 out')
    // The terminal SELECT is represented by the final node, which carries the
    // real result rows rather than a duplicate projected-rows node.
    const final = graph.nodes.find((node) => node.kind === 'final')!
    expect(final.label).toBe('Final result')
    expect(final.detail).toBe('1 row')
    expect(final.rows).toEqual([{ id: 'r1', values: ['A'] }])
  })

  it('gives every edge a label point on the routed curve', () => {
    const graph = buildFlowGraph(makeTrace())
    for (const edge of graph.edges) {
      expect(edge.labelPoint).toBeDefined()
      const xs = edge.curve.map((point) => point.x)
      const ys = edge.curve.map((point) => point.y)
      if (xs.length === 0 || ys.length === 0) continue
      expect(edge.labelPoint!.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1)
      expect(edge.labelPoint!.x).toBeLessThanOrEqual(Math.max(...xs) + 1)
      expect(edge.labelPoint!.y).toBeGreaterThanOrEqual(Math.min(...ys) - 1)
      expect(edge.labelPoint!.y).toBeLessThanOrEqual(Math.max(...ys) + 1)
    }
  })

  it('keeps every node inside the computed bounds', () => {
    const graph = buildFlowGraph(
      makeTrace({
        stages: ['FROM', 'WHERE', 'GROUP_BY', 'HAVING', 'SELECT', 'ORDER_BY', 'LIMIT'],
        stageSnapshots: [
          snapshot('FROM', 8),
          snapshot('WHERE', 6, 2),
          snapshot('GROUP_BY', 3, 0, [groupSnapshot(1, 2), groupSnapshot(2, 2), groupSnapshot(3, 2)]),
          snapshot('HAVING', 2, 1),
          snapshot('SELECT', 2),
          snapshot('ORDER_BY', 2),
          snapshot('LIMIT', 1, 1),
        ],
        capability: {
          supported: true,
          supportedStages: ['FROM', 'WHERE', 'GROUP_BY', 'HAVING', 'SELECT', 'ORDER_BY', 'LIMIT'],
          unsupportedFeatures: [],
          warnings: [],
          detected: [],
          isReadOnly: true,
          hasAggregation: true,
          hasJoin: false,
          estimatedComplexity: 'small',
        },
      }),
    )
    for (const node of graph.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(graph.bounds.width)
      expect(node.y + node.height).toBeLessThanOrEqual(graph.bounds.height)
    }
    // A seven-stage pipeline should produce a tall but bounded graph.
    expect(graph.bounds.height).toBeGreaterThan(800)
  })
})

describe('buildFlowGraph — sockets and wire routing', () => {
  it('attaches every wire to real output/input sockets', () => {
    const graph = buildFlowGraph(makeTrace())
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    for (const edge of graph.edges) {
      const from = byId.get(edge.from)!
      const to = byId.get(edge.to)!
      const fromSocket = from.sockets.find((socket) => socket.id === edge.fromSocket)
      const toSocket = to.sockets.find((socket) => socket.id === edge.toSocket)
      expect(fromSocket?.direction).toBe('output')
      expect(toSocket?.direction).toBe('input')
      // Cubic Bézier control points, starting/ending on socket centres.
      expect(edge.curve).toHaveLength(4)
      expect(edge.curve[0]).toEqual(socketPoint(from, fromSocket!))
      expect(edge.curve[3]).toEqual(socketPoint(to, toSocket!))
    }
  })

  it('gives JOIN two lateral inputs and a bottom output', () => {
    const graph = buildFlowGraph(
      makeTrace({
        stages: ['FROM', 'JOIN', 'SELECT'],
        sourceTables: [
          sourceTable('employees', 'from', 8),
          sourceTable('departments', 'join', 3, 'INNER JOIN'),
        ],
        stageSnapshots: [snapshot('FROM', 8), snapshot('JOIN', 8), snapshot('SELECT', 8)],
      }),
    )
    const join = graph.nodes.find((node) => node.id === 'op-JOIN')!
    const inputs = join.sockets.filter((socket) => socket.direction === 'input')
    expect(inputs).toHaveLength(2)
    expect(inputs.every((socket) => socket.side === 'left')).toBe(true)
    const output = join.sockets.find((socket) => socket.id === 'out')
    expect(output?.side).toBe('bottom')
    expect(output?.kind).toBe('data')
  })

  it('marks branch outputs as hollow branch sockets and sources as right outputs', () => {
    const graph = buildFlowGraph(makeTrace())
    const where = graph.nodes.find((node) => node.id === 'op-WHERE')!
    expect(where.sockets.find((socket) => socket.id === 'out-branch')?.kind).toBe('branch')
    expect(where.sockets.find((socket) => socket.id === 'out')?.side).toBe('bottom')
    const source = graph.nodes.find((node) => node.kind === 'source')!
    expect(source.sockets[0]?.side).toBe('right')
    expect(source.sockets[0]?.direction).toBe('output')
  })

  it('computes honest expanded preview heights from real rows', () => {
    const graph = buildFlowGraph(makeTrace())
    const source = graph.nodes.find((node) => node.kind === 'source')!
    const data = graph.nodes.find((node) => node.id === 'data-WHERE')!
    // The fixture has three source preview rows and four data rows, so
    // only the data node can reveal more.
    expect(source.expandedHeight).toBeUndefined()
    expect(data.expandedHeight).toBeGreaterThan(data.height)
    expect(graph.nodes.find((node) => node.kind === 'final')?.expandedHeight).toBeUndefined()
    // The branch shows no preview until expanded, so its expanded height
    // must fit the preview table chrome plus every real removed row — not
    // just one more row.
    const branch = graph.nodes.find((node) => node.kind === 'branch')!
    expect(branch.removedRows).toHaveLength(4)
    expect(branch.expandedHeight).toBeGreaterThanOrEqual(branch.height + 4 * 17)
    expect(branch.expandedHeight).toBeGreaterThan(branch.height + 17)
  })
})

describe('deriveFlowState', () => {
  const graph = buildFlowGraph(makeTrace())

  it('hides rejected branches and keeps sources visible before their stage runs', () => {
    const state = deriveFlowState(graph, new Set(['FROM']), 'WHERE', false)
    expect(state.nodes['branch-WHERE']).toBe('hidden')
    expect(state.nodes[graph.nodes.find((node) => node.kind === 'source')!.id]).toBe('completed')
    expect(state.nodes['op-WHERE']).toBe('active')
    expect(state.nodes['op-SELECT']).toBe('pending')
  })

  it('marks completed stages and reveals branches only after completion', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    expect(state.nodes['op-WHERE']).toBe('completed')
    expect(state.nodes['data-WHERE']).toBe('completed')
    expect(state.nodes['branch-WHERE']).toBe('completed')
    expect(state.nodes['op-SELECT']).toBe('active')
    // The WHERE edge is completed; the SELECT edge is active.
    const whereEdge = graph.edges.find((edge) => edge.stage === 'WHERE' && edge.kind === 'main')
    expect(state.edges[whereEdge!.id]).toBe('completed')
    const selectEdge = graph.edges.find((edge) => edge.stage === 'SELECT' && edge.kind === 'main')
    expect(state.edges[selectEdge!.id]).toBe('active')
    expect(state.packetEdgeIds).toContain(selectEdge!.id)
  })

  it('completes the final node only when the last stage completes', () => {
    const before = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    expect(before.nodes['final']).toBe('pending')
    const after = deriveFlowState(graph, new Set(['FROM', 'WHERE', 'SELECT']), null, true)
    expect(after.nodes['final']).toBe('completed')
    expect(after.packetEdgeIds).toHaveLength(0)
  })

  it('shows join inputs immediately and animates them into the JOIN', () => {
    const joinTrace = makeTrace({
      stages: ['FROM', 'JOIN', 'SELECT'],
      sourceTables: [sourceTable('employees', 'from', 8), sourceTable('departments', 'join', 3, 'INNER JOIN')],
      stageSnapshots: [snapshot('FROM', 8), snapshot('JOIN', 8), snapshot('SELECT', 8)],
    })
    const joinGraph = buildFlowGraph(joinTrace)
    const state = deriveFlowState(joinGraph, new Set(['FROM']), 'JOIN', false)
    // Both tables exist before the query runs, so both are visible and the
    // second one's edge carries data into the active JOIN.
    const joinSource = joinGraph.nodes.find((node) => node.kind === 'source' && node.table?.role === 'join')!
    expect(joinSource.revealsAt).toBeNull()
    expect(state.nodes[joinSource.id]).toBe('completed')
    const edge = joinGraph.edges.find((candidate) => candidate.from === joinSource.id)!
    expect(state.edges[edge.id]).toBe('active')
    expect(state.packetEdgeIds).toContain(edge.id)
    expect(state.nodes['op-JOIN']).toBe('active')
  })

  it('hides edges whose target node has not been produced yet', () => {
    // The WHERE snapshot exists only after WHERE completes, so its edge is
    // not shown while the stage is still running.
    const state = deriveFlowState(graph, new Set(['FROM']), 'WHERE', false)
    const dataWhereEdge = graph.edges.find((edge) => edge.to === 'data-WHERE')!
    expect(state.nodes['data-WHERE']).toBe('hidden')
    expect(state.edges[dataWhereEdge.id]).toBe('hidden')
  })
})

describe('buildFlowGraph — nested query sources', () => {
  const subqueryTrace = makeTrace({
    sourceTables: [
      sourceTable('employees', 'from', 8),
      {
        name: 'Scalar subquery · AVG(salary)',
        alias: null,
        columns: ['AVG(salary)'],
        rowCount: 1,
        previewRows: [{ id: 'q#r1', values: [54250] }],
        role: 'subquery',
        joinType: null,
        on: null,
        queryId: 'q2',
        consumerStage: 'WHERE',
      },
    ],
    nestedQueries: [
      {
        id: 'q2',
        kind: 'scalar',
        label: 'Scalar subquery · AVG(salary)',
        sql: 'SELECT AVG(salary) FROM employees',
        stageSnapshots: [],
        finalColumns: ['AVG(salary)'],
        finalRows: [{ id: 'q#r1', values: [54250] }],
        parentStage: 'WHERE',
        correlated: false,
      },
    ],
  })

  it('creates a real source node for the nested result', () => {
    const graph = buildFlowGraph(subqueryTrace)
    const nested = graph.nodes.find((node) => node.table?.role === 'subquery')
    expect(nested).toBeDefined()
    expect(nested?.stage).toBe('WHERE')
    expect(nested?.label).toBe('Scalar subquery · AVG(salary)')
    expect(nested?.detail).toContain('Nested query result')
    expect(nested?.table?.previewRows[0]?.values[0]).toBe(54250)
  })

  it('wires the nested result into the consuming operation only', () => {
    const graph = buildFlowGraph(subqueryTrace)
    const nested = graph.nodes.find((node) => node.table?.role === 'subquery')!
    const incoming = graph.edges.filter((edge) => edge.from === nested.id)
    expect(incoming).toHaveLength(1)
    expect(incoming[0]).toMatchObject({
      to: 'op-WHERE',
      stage: 'WHERE',
      kind: 'join-input',
      label: 'value',
    })
    const op = graph.nodes.find((node) => node.id === 'op-WHERE')!
    expect(op.sockets.some((socket) => socket.id === incoming[0]?.toSocket)).toBe(true)
    // Nothing is wired into the SELECT operation from the subquery.
    expect(
      graph.edges.some((edge) => edge.from === nested.id && edge.to === 'op-SELECT'),
    ).toBe(false)
  })

  it('stacks nested sources below real tables so nodes never overlap', () => {
    const graph = buildFlowGraph(subqueryTrace)
    const primary = graph.nodes.find((node) => node.table?.role === 'from')!
    const nested = graph.nodes.find((node) => node.table?.role === 'subquery')!
    expect(nested.y).toBeGreaterThan(primary.y + primary.height)
    for (const node of graph.nodes) {
      expect(node.y + node.height).toBeLessThanOrEqual(graph.bounds.height)
    }
  })

  it('treats the nested result as available before playback (computed first)', () => {
    const graph = buildFlowGraph(subqueryTrace)
    const nested = graph.nodes.find((node) => node.table?.role === 'subquery')!
    const state = deriveFlowState(graph, new Set(), null, false)
    expect(state.nodes[nested.id]).toBe('completed')
  })

  it('stays deterministic for the same nested trace', () => {
    expect(buildFlowGraph(subqueryTrace)).toEqual(buildFlowGraph(subqueryTrace))
  })
})
