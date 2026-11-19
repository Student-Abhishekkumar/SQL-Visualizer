import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { buildFlowGraph } from './graphBuilder'
import { inspectNode } from './nodeInspection'
import { simulateQuery, type SimulationOptions, type TableData } from './simulator'

const a: TableData = {
  columns: ['id', 'v'],
  rows: [
    [1, 'x'],
    [2, 'y'],
    [null, 'n'],
    [2, 'y'],
    [3, 'z'],
    [4, 'd'],
  ],
}

const b: TableData = {
  columns: ['id', 'v'],
  rows: [
    [2, 'y'],
    [null, 'n'],
    [4, 'd'],
    [2, 'y'],
    [5, 'q'],
  ],
}

const c: TableData = {
  columns: ['id', 'v'],
  rows: [
    [2, 'y'],
    [3, 'z'],
    [5, 'q'],
  ],
}

const empty: TableData = { columns: ['id', 'v'], rows: [] }
const one: TableData = { columns: ['id', 'v'], rows: [[1, 'one']] }
const two: TableData = { columns: ['id', 'v'], rows: [[2, 'two']] }
const TABLES: Record<string, TableData> = { a, b, c, empty, one, two }
const getTableData = (name: string): TableData | null => TABLES[name] ?? null

function interpret(sql: string) {
  return interpretQuery(sql, [sql])
}

function run(sql: string, options: SimulationOptions = {}) {
  const interpretation = interpret(sql)
  expect(interpretation.unsupportedReasons).toEqual([])
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData, options)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

function values(sql: string): unknown[][] {
  return run(sql).finalRows.map((row) => row.values)
}

describe('INTERSECT and EXCEPT simulation', () => {
  it('returns distinct rows present in both inputs for INTERSECT', () => {
    expect(values('SELECT id, v FROM a INTERSECT SELECT id, v FROM b')).toEqual([
      [2, 'y'],
      [null, 'n'],
      [4, 'd'],
    ])
  })

  it('returns distinct left rows absent from the right input for EXCEPT', () => {
    expect(values('SELECT id, v FROM a EXCEPT SELECT id, v FROM b')).toEqual([
      [1, 'x'],
      [3, 'z'],
    ])
  })

  it('removes and records duplicates from both inputs', () => {
    const trace = run('SELECT id, v FROM a EXCEPT SELECT id, v FROM empty')
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 'x'],
      [2, 'y'],
      [null, 'n'],
      [3, 'z'],
      [4, 'd'],
    ])

    const intersect = run('SELECT id, v FROM a INTERSECT SELECT id, v FROM b')
    const compound = intersect.stageSnapshots.find((snapshot) => snapshot.stage === 'COMPOUND')!
    expect(compound.removedRows.map((row) => row.id)).toEqual(
      expect.arrayContaining(['q2:a#4', 'q3:b#4']),
    )
    expect(compound.roles['q2:a#4']).toBe('duplicated')
    expect(compound.roles['q3:b#4']).toBe('duplicated')
  })

  it('uses NULL-safe row comparison rather than SQL equality semantics', () => {
    const intersection = values('SELECT id FROM a INTERSECT SELECT id FROM b')
    expect(intersection).toEqual([[2], [null], [4]])

    const difference = values('SELECT id FROM a EXCEPT SELECT id FROM b')
    expect(difference).toEqual([[1], [3]])
    expect(difference).not.toContainEqual([null])
  })

  it('compares complete multi-column rows', () => {
    expect(values("SELECT id, v FROM a INTERSECT SELECT id, 'x' AS v FROM a")).toEqual([
      [1, 'x'],
    ])
  })

  it('evaluates UNION before INTERSECT left to right, without precedence rewriting', () => {
    expect(
      values('SELECT id AS n FROM one UNION SELECT id FROM two INTERSECT SELECT id FROM two'),
    ).toEqual([[2]])
  })

  it('deduplicates an earlier UNION ALL result when INTERSECT applies', () => {
    expect(
      values('SELECT id AS n FROM one UNION ALL SELECT id FROM one INTERSECT SELECT id FROM one'),
    ).toEqual([[1]])
  })

  it('folds EXCEPT and a following UNION left to right', () => {
    expect(values('SELECT id, v FROM a EXCEPT SELECT id, v FROM b UNION SELECT id, v FROM c')).toEqual([
      [1, 'x'],
      [3, 'z'],
      [2, 'y'],
      [5, 'q'],
    ])
  })

  it('evaluates three or more operators strictly left to right', () => {
    const sql = `SELECT id, v FROM a
      UNION ALL SELECT id, v FROM b
      INTERSECT SELECT id, v FROM b
      EXCEPT SELECT id, v FROM c
      UNION ALL SELECT id, v FROM one`
    expect(values(sql)).toEqual([
      [null, 'n'],
      [4, 'd'],
      [1, 'one'],
    ])
  })

  it('handles empty inputs on either side', () => {
    expect(values('SELECT id, v FROM a INTERSECT SELECT id, v FROM empty')).toEqual([])
    expect(values('SELECT id, v FROM empty EXCEPT SELECT id, v FROM a')).toEqual([])
    expect(values('SELECT id, v FROM a EXCEPT SELECT id, v FROM empty')).toHaveLength(5)
  })

  it('preserves the first branch column names', () => {
    const trace = run(
      'SELECT id AS left_id, v AS label FROM a INTERSECT SELECT id AS right_id, v AS other FROM b',
    )
    expect(trace.finalColumns).toEqual(['left_id', 'label'])
    expect(trace.stageSnapshots[0]?.columns).toEqual(['left_id', 'label'])
  })

  it.each(['INTERSECT', 'EXCEPT'] as const)('rejects column-count mismatch for %s', (operator) => {
    const sql = `SELECT id FROM a ${operator} SELECT id, v FROM b`
    const outcome = simulateQuery(sql, interpret(sql).structure!, getTableData)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('same number of columns')
  })

  it('enforces the compound row cap and marks the result incomplete', () => {
    const trace = run(
      'SELECT id, v FROM a UNION ALL SELECT id, v FROM b EXCEPT SELECT id, v FROM empty',
      { maxRows: 2 },
    )
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 'x'],
      [2, 'y'],
    ])
    expect(trace.truncated).toBe(true)
    expect(trace.incomplete).toBe(true)
    const compound = trace.stageSnapshots.find((snapshot) => snapshot.stage === 'COMPOUND')!
    expect(compound.truncated).toBe(true)
    expect(compound.incomplete).toBe(true)
  })

  it('enforces the event cap without dropping output rows or snapshots', () => {
    const trace = run('SELECT id, v FROM a INTERSECT SELECT id, v FROM b', { maxEvents: 1 })
    const fineEvents = trace.events.filter(
      (event) => event.stage === 'COMPOUND' && event.type !== 'STAGE_COMPLETED',
    )
    expect(fineEvents).toHaveLength(1)
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [2, 'y'],
      [null, 'n'],
      [4, 'd'],
    ])
    expect(trace.stageSnapshots.some((snapshot) => snapshot.stage === 'COMPOUND')).toBe(true)
    expect(trace.truncated).toBe(false)
    expect(trace.incomplete).toBe(false)
  })

  it('propagates incomplete branches into the compound snapshot', () => {
    const trace = run('SELECT id, v FROM a EXCEPT SELECT id, v FROM b', { maxRows: 2 })
    expect(trace.finalRows.map((row) => row.values)).toEqual([[1, 'x']])
    expect(trace.truncated).toBe(true)
    expect(trace.incomplete).toBe(true)
    expect(trace.incompleteReasons?.length).toBeGreaterThan(0)
    const compound = trace.stageSnapshots.find((snapshot) => snapshot.stage === 'COMPOUND')!
    expect(compound.incomplete).toBe(true)
    expect(compound.incompleteReasons?.length).toBeGreaterThan(0)
    expect((trace.nestedQueries ?? []).every((block) => block.incomplete === true)).toBe(true)
  })

  it('exposes retained, excluded and duplicate rows through snapshots and inspectors', () => {
    const trace = run('SELECT id, v FROM a EXCEPT SELECT id, v FROM b')
    const compound = trace.stageSnapshots.find((snapshot) => snapshot.stage === 'COMPOUND')!
    expect(compound.rows.map((row) => row.values)).toEqual([
      [1, 'x'],
      [3, 'z'],
    ])
    expect(compound.roles['q2:a#2']).toBe('filtered')
    expect(compound.roles['q2:a#4']).toBe('duplicated')
    expect(compound.roles['q3:b#4']).toBe('duplicated')
    expect(compound.rows.every((row) => compound.roles[row.id] === 'unchanged')).toBe(true)

    const graph = buildFlowGraph(trace)
    const operation = graph.nodes.find((node) => node.id === 'op-COMPOUND')!
    const operationInspection = inspectNode(operation, trace)
    expect(operationInspection.inputs).toHaveLength(2)
    expect(operationInspection.output?.rows).toEqual(compound.rows)
    expect(operationInspection.details.rejected).toBe(compound.removedRows.length)

    const branch = graph.nodes.find((node) => node.kind === 'branch' && node.stage === 'COMPOUND')!
    const branchInspection = inspectNode(branch, trace)
    expect(branchInspection.output?.rows).toEqual(compound.removedRows)
    expect(branchInspection.overview.description).toMatch(/EXCEPT/)
  })

  it('keeps branch events and compound events deterministic and left to right', () => {
    const sql =
      'SELECT id, v FROM a UNION SELECT id, v FROM a INTERSECT SELECT id, v FROM a EXCEPT SELECT id, v FROM b'
    const trace = run(sql)
    const events = trace.events.filter(
      (event) => event.stage === 'COMPOUND' && event.type !== 'STAGE_COMPLETED',
    )
    const union = events.findIndex((event) => event.description.includes('UNION'))
    const intersect = events.findIndex((event) => event.description.includes('INTERSECT'))
    const except = events.findIndex((event) => event.description.includes('EXCEPT'))
    expect(union).toBeGreaterThanOrEqual(0)
    expect(intersect).toBeGreaterThan(union)
    expect(except).toBeGreaterThan(intersect)

    const branches = trace.nestedQueries ?? []
    expect(branches).toHaveLength(4)
    for (const branch of branches) {
      expect(branch.stageSnapshots.length).toBeGreaterThan(0)
      expect(branch.events?.length ?? 0).toBeGreaterThan(0)
    }
    expect(run(sql).events).toEqual(trace.events)
  })
})
