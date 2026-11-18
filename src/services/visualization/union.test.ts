import { describe, expect, it } from 'vitest'
import { interpretQuery, structureText } from './astInterpreter'
import { analyzeCapability } from './capabilityAnalyzer'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { traceUpstreamPath } from './flowPath'
import { blocksOf } from './queryBlocks'
import { inspectNode } from './nodeInspection'
import { simulateQuery, type SimulationOptions, type TableData } from './simulator'

/**
 * UNION / UNION ALL compound selects.
 *
 * Each SELECT branch is an independent query block with its own real
 * snapshots and playback events. Branches feed a shared COMPOUND stage;
 * UNION removes duplicates from the accumulated result, UNION ALL keeps
 * every row. All expectations below are computed from the real branch
 * rows, not from the SQL text.
 */

const a: TableData = {
  columns: ['id', 'v'],
  rows: [
    [1, 'x'],
    [2, 'y'],
    [null, 'n'],
    [2, 'y'],
  ],
}

const b: TableData = {
  columns: ['id', 'v'],
  rows: [
    [2, 'y'],
    [3, 'z'],
    [null, 'n'],
  ],
}

const c: TableData = {
  columns: ['id', 'v'],
  rows: [
    [1, 'x'],
    [4, 'w'],
  ],
}

const TABLES: Record<string, TableData> = { a, b, c }
const getTableData = (name: string): TableData | null => TABLES[name] ?? null

function interpret(sql: string) {
  return interpretQuery(sql, [sql])
}

function run(sql: string, options: SimulationOptions = {}) {
  const interpretation = interpret(sql)
  expect(interpretation.unsupportedReasons).toEqual([])
  expect(interpretation.structure).not.toBeNull()
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData, options)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

function firstColumn(trace: ReturnType<typeof run>): unknown[] {
  expect(trace.finalColumns.length).toBeGreaterThan(0)
  return trace.finalRows.map((row) => row.values[0])
}

function countOf(values: unknown[], wanted: unknown): number {
  return values.filter((value) => value === wanted).length
}

describe('UNION / UNION ALL interpretation', () => {
  it('models the compound root and one independent block per branch', () => {
    const sql = 'SELECT id FROM a UNION SELECT id FROM b UNION ALL SELECT id FROM c ORDER BY id LIMIT 5'
    const structure = interpret(sql).structure!
    expect(structure.compound).not.toBeNull()
    expect(structure.compound!.branches).toHaveLength(3)
    expect(structure.compound!.branches.map((branch) => branch.operator)).toEqual([
      null,
      'UNION',
      'UNION ALL',
    ])
    // The compound's trailing clauses are hoisted from the terminal branch.
    expect(structure.orderBy).toHaveLength(1)
    expect(structure.limit?.limit).toBe(5)
    expect(structureText(structure)).toContain('UNION ALL')

    const branches = structure.compound!.branches.map((branch) => branch.query)
    expect(branches.map((branch) => branch.id)).toEqual(['q2', 'q3', 'q4'])
    for (const branch of branches) {
      expect(branch.blockKind).toBe('compound')
      expect(branch.parentId).toBe('q1')
      expect(branch.depth).toBe(1)
      expect(branch.orderBy).toHaveLength(0)
      expect(branch.limit).toBeNull()
    }
  })

  it('reports compound capability and stages without claiming INTERSECT support', () => {
    const capability = analyzeCapability(interpret('SELECT id FROM a UNION ALL SELECT id FROM b'))
    expect(capability.supported).toBe(true)
    expect(capability.supportedStages).toEqual(['COMPOUND'])
    expect(capability.detected.some((entry) => entry.kind === 'compound')).toBe(true)

    const unsupported = interpret('SELECT id FROM a INTERSECT SELECT id FROM b')
    expect(unsupported.structure).toBeNull()
    expect(unsupported.unsupportedReasons.length).toBeGreaterThan(0)
  })
})

describe('UNION / UNION ALL simulation', () => {
  it('removes duplicates across the whole UNION result', () => {
    const trace = run('SELECT id, v FROM a UNION SELECT id, v FROM b')
    const ids = trace.finalRows.map((row) => row.values[0])
    expect(trace.finalRows).toHaveLength(4)
    expect(countOf(ids, 2)).toBe(1)
    expect(countOf(ids, null)).toBe(1)
    expect(trace.stages).toEqual(['COMPOUND'])
    expect(trace.compound?.branches).toHaveLength(2)
  })

  it('keeps every row for UNION ALL, including duplicates', () => {
    const trace = run('SELECT id FROM a UNION ALL SELECT id FROM b')
    const ids = firstColumn(trace)
    expect(trace.finalRows).toHaveLength(a.rows.length + b.rows.length)
    expect(countOf(ids, 2)).toBe(3)
    expect(countOf(ids, null)).toBe(2)
    const compound = trace.stageSnapshots.find((snapshot) => snapshot.stage === 'COMPOUND')!
    expect(compound.removedRows).toHaveLength(0)
  })

  it('treats NULL as equal to NULL only for UNION duplicate removal', () => {
    const union = run('SELECT id FROM a UNION SELECT id FROM b')
    const unionAll = run('SELECT id FROM a UNION ALL SELECT id FROM b')
    expect(countOf(firstColumn(union), null)).toBe(1)
    expect(countOf(firstColumn(unionAll), null)).toBe(2)
  })

  it('folds mixed operators left-to-right', () => {
    // A UNION ALL B UNION C => (A + B) deduplicated, then combined with C.
    const unionLast = run('SELECT id FROM a UNION ALL SELECT id FROM b UNION SELECT id FROM c')
    expect(unionLast.finalRows).toHaveLength(5)
    const unionFirst = run('SELECT id FROM a UNION SELECT id FROM b UNION ALL SELECT id FROM c')
    const ids = firstColumn(unionFirst)
    expect(unionFirst.finalRows).toHaveLength(6)
    expect(countOf(ids, 1)).toBe(2)
  })

  it('applies the compound ORDER BY and LIMIT after folding', () => {
    const trace = run('SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id DESC LIMIT 3')
    expect(trace.stages).toEqual(['COMPOUND', 'ORDER_BY', 'LIMIT'])
    expect(firstColumn(trace)).toEqual([3, 2, 2])
    expect(trace.hasDeterministicOrder).toBe(false) // duplicate 2s tie
    expect(trace.stageSnapshots.map((snapshot) => snapshot.blockId)).toEqual(['q1', 'q1', 'q1'])
  })

  it('supports ordinal compound ORDER BY', () => {
    const trace = run('SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY 1 LIMIT 2')
    expect(firstColumn(trace)).toEqual([null, null])
  })

  it('gives every branch its own snapshots, events and identity', () => {
    const trace = run('SELECT id FROM a UNION SELECT id FROM b')
    const branches = trace.nestedQueries ?? []
    expect(branches).toHaveLength(2)
    expect(branches.every((block) => block.kind === 'compound')).toBe(true)
    expect(branches.map((block) => block.id)).toEqual(['q2', 'q3'])
    expect(branches.every((block) => block.parentId === 'q1')).toBe(true)
    expect(branches.every((block) => block.depth === 1)).toBe(true)
    expect(branches.every((block) => block.stageSnapshots.length > 0)).toBe(true)
    for (const block of branches) {
      expect(block.stageSnapshots.every((snapshot) => snapshot.blockId === block.id)).toBe(true)
      expect((block.events ?? []).every((event) => event.blockId === block.id)).toBe(true)
      expect(block.finalRows.length).toBeGreaterThan(0)
    }
    expect(new Set(branches.flatMap((block) => block.finalRows.map((row) => row.id))).size).toBe(
      branches.reduce((sum, block) => sum + block.finalRows.length, 0),
    )
  })

  it('rejects branches with different column counts instead of guessing', () => {
    const sql = 'SELECT id FROM a UNION SELECT id, v FROM b'
    const structure = interpret(sql).structure!
    const outcome = simulateQuery(sql, structure, getTableData)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reasons.join(' ')).toContain('same number of columns')
    }
  })
})

describe('UNION graph, playback and inspector integration', () => {
  const sql = 'SELECT id FROM a UNION ALL SELECT id FROM b ORDER BY id'
  const trace = run(sql)
  const graph = buildFlowGraph(trace)

  it('wires every branch subgraph into the shared COMPOUND node', () => {
    const compoundOp = graph.nodes.find((node) => node.id === 'op-COMPOUND')
    expect(compoundOp).toBeDefined()
    expect(compoundOp!.stage).toBe('COMPOUND')
    expect(graph.nodes.some((node) => node.id === 'data-COMPOUND')).toBe(true)

    const branchEdges = graph.edges.filter((edge) => edge.kind === 'compound')
    expect(branchEdges).toHaveLength(2)
    for (const edge of branchEdges) {
      expect(edge.to).toBe('op-COMPOUND')
      expect(edge.from.startsWith('q2') || edge.from.startsWith('q3')).toBe(true)
    }
  })

  it('traces upstream from the compound result into both branches', () => {
    const path = traceUpstreamPath(graph, 'op-COMPOUND')
    expect(path.hasSelection).toBe(true)
    expect([...path.nodeIds].some((id) => id.startsWith('q2'))).toBe(true)
    expect([...path.nodeIds].some((id) => id.startsWith('q3'))).toBe(true)
  })

  it('reveals compound playback only after both branch stages complete', () => {
    const branchKeys = (trace.nestedQueries ?? []).map((block) => {
      const last = block.stageSnapshots[block.stageSnapshots.length - 1]!
      return `${block.id}:${last.stage}`
    })
    const before = deriveFlowState(graph, new Set(branchKeys), null, false)
    expect(before.nodes['op-COMPOUND']).toBe('pending')
    expect(before.nodes['data-COMPOUND']).toBe('hidden')

    const after = deriveFlowState(graph, new Set([...branchKeys, 'COMPOUND']), null, false)
    expect(after.nodes['op-COMPOUND']).toBe('completed')
    expect(after.nodes['data-COMPOUND']).toBe('completed')
  })

  it('lists the compound root and branch blocks for playback', () => {
    const blocks = blocksOf(trace)
    expect(blocks[0]?.label).toBe('Compound result')
    expect(blocks.slice(1).every((block) => block.kind === 'compound')).toBe(true)
    expect(blocks.slice(1).every((block) => block.playable)).toBe(true)
    expect(blocks.slice(1).every((block) => block.depth === 1)).toBe(true)
  })

  it('shows every branch output as an input of the COMPOUND operation', () => {
    const compoundOp = graph.nodes.find((node) => node.id === 'op-COMPOUND')!
    const inspection = inspectNode(compoundOp, trace)
    expect(inspection.inputs).toHaveLength(2)
    expect(inspection.inputs.map((input) => input.label)).toEqual([
      'Branch 1 · id',
      'Branch 2 · id',
    ])
    expect(inspection.output?.rows).toHaveLength(trace.finalRows.length)
  })
})

describe('UNION truncation propagation', () => {
  it('marks capped branches and a capped compound result as incomplete', () => {
    const trace = run('SELECT id FROM a UNION ALL SELECT id FROM b', { maxRows: 2 })
    expect(trace.finalRows).toHaveLength(2)
    expect(trace.truncated).toBe(true)
    expect(trace.incomplete).toBe(true)
    expect((trace.incompleteReasons ?? []).length).toBeGreaterThan(0)

    const compound = trace.stageSnapshots.find((snapshot) => snapshot.stage === 'COMPOUND')!
    expect(compound.truncated).toBe(true)
    expect(compound.incomplete).toBe(true)
    expect((compound.incompleteReasons ?? []).length).toBeGreaterThan(0)

    for (const branch of trace.nestedQueries ?? []) {
      expect(branch.truncated).toBe(true)
      expect(branch.incomplete).toBe(true)
    }
  })
})
