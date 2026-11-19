import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { traceUpstreamPath } from './flowPath'
import { inspectNode } from './nodeInspection'
import { simulateQuery, type SimulationOptions, type TableData } from './simulator'
import { foldEvents } from '../../store/visualizationStore'

const a: TableData = {
  columns: ['id', 'v'],
  rows: [[1, 'x'], [2, 'y'], [null, 'n'], [2, 'y'], [3, 'z'], [4, 'd']],
}
const b: TableData = {
  columns: ['id', 'v'],
  rows: [[2, 'y'], [null, 'n'], [4, 'd'], [2, 'y'], [5, 'q']],
}
const c: TableData = { columns: ['id', 'v'], rows: [[2, 'y'], [3, 'z'], [5, 'q']] }
const one: TableData = { columns: ['id', 'v'], rows: [[1, 'one']] }
const TABLES = { a, b, c, one }
const getTableData = (name: string): TableData | null => TABLES[name as keyof typeof TABLES] ?? null

function run(sql: string, options: SimulationOptions = {}) {
  const interpretation = interpretQuery(sql, [sql])
  expect(interpretation.unsupportedReasons).toEqual([])
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData, options)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

const MIXED = `SELECT id, v FROM a
  UNION ALL SELECT id, v FROM b
  INTERSECT SELECT id, v FROM b
  EXCEPT SELECT id, v FROM c
  UNION ALL SELECT id, v FROM one`

describe('set-operation graph and inspector integration', () => {
  it('creates an INTERSECT node with real branch connections and inspection rows', () => {
    const trace = run('SELECT id, v FROM a INTERSECT SELECT id, v FROM b')
    const graph = buildFlowGraph(trace)
    const operation = graph.nodes.find((node) => node.id === 'op-COMPOUND')!
    expect(operation.label).toBe('INTERSECT')
    expect(operation.compoundOperationId).toBe('COMPOUND')
    expect(graph.edges.filter((edge) => edge.kind === 'compound')).toHaveLength(2)

    const inspection = inspectNode(operation, trace)
    expect(inspection.inputs.map((input) => input.label)).toEqual([
      'Accumulated left input',
      'Next right input · Branch 2 · id, v',
    ])
    expect(inspection.inputs[0]?.rows).toHaveLength(a.rows.length)
    expect(inspection.inputs[1]?.rows).toHaveLength(b.rows.length)
    expect(inspection.output?.rows.map((row) => row.values)).toEqual([
      [2, 'y'],
      [null, 'n'],
      [4, 'd'],
    ])
    expect(inspection.details.rejected).toBeGreaterThan(0)
    expect(inspection.overview.description).toMatch(/INTERSECT/)
  })

  it('creates an EXCEPT node with retained, excluded and duplicate rows', () => {
    const trace = run('SELECT id, v FROM a EXCEPT SELECT id, v FROM b')
    const graph = buildFlowGraph(trace)
    const operation = graph.nodes.find((node) => node.id === 'op-COMPOUND')!
    expect(operation.label).toBe('EXCEPT')

    const inspection = inspectNode(operation, trace)
    expect(inspection.output?.rows.map((row) => row.values)).toEqual([
      [1, 'x'],
      [3, 'z'],
    ])
    const snapshot = operation.snapshot!
    expect(snapshot.roles['q2:a#2']).toBe('filtered')
    expect(snapshot.roles['q2:a#4']).toBe('duplicated')
    expect(snapshot.roles['q3:b#4']).toBe('duplicated')
    expect(snapshot.removedRows.length).toBeGreaterThan(0)
    expect(inspection.overview.description).toMatch(/EXCEPT/)
  })

  it('represents a mixed chain as sequential operation nodes, not one simultaneous fold', () => {
    const trace = run(MIXED)
    const graph = buildFlowGraph(trace)
    const operations = graph.nodes.filter(
      (node) => node.kind === 'operation' && node.stage === 'COMPOUND',
    )
    expect(operations.map((node) => node.id)).toEqual([
      'op-COMPOUND-1',
      'op-COMPOUND-2',
      'op-COMPOUND-3',
      'op-COMPOUND',
    ])
    expect(operations.map((node) => node.label)).toEqual([
      'UNION ALL',
      'INTERSECT',
      'EXCEPT',
      'UNION ALL',
    ])
    expect(operations.every((node, index) => index === 0 || node.y > operations[index - 1]!.y)).toBe(true)

    for (const [from, to] of [
      ['data-COMPOUND-1', 'op-COMPOUND-2'],
      ['data-COMPOUND-2', 'op-COMPOUND-3'],
      ['data-COMPOUND-3', 'op-COMPOUND'],
    ]) {
      expect(graph.edges.some((edge) => edge.from === from && edge.to === to)).toBe(true)
    }
    const compoundTargets = graph.edges
      .filter((edge) => edge.kind === 'compound')
      .map((edge) => edge.to)
    expect(compoundTargets).toEqual([
      'op-COMPOUND-1',
      'op-COMPOUND-1',
      'op-COMPOUND-2',
      'op-COMPOUND-3',
      'op-COMPOUND',
    ])
  })

  it('traces only the actual upstream operations and branches', () => {
    const graph = buildFlowGraph(run(MIXED))
    const path = traceUpstreamPath(graph, 'op-COMPOUND-3')
    expect(path.hasSelection).toBe(true)
    expect(path.nodeIds).toContain('op-COMPOUND-1')
    expect(path.nodeIds).toContain('op-COMPOUND-2')
    expect([...path.nodeIds].some((id) => id.startsWith('q2'))).toBe(true)
    expect([...path.nodeIds].some((id) => id.startsWith('q4'))).toBe(true)
    expect([...path.nodeIds].some((id) => id.startsWith('q5'))).toBe(true)
    expect([...path.nodeIds].some((id) => id.startsWith('q6'))).toBe(false)
  })

  it('plays each intermediate snapshot in left-to-right order', () => {
    const trace = run(MIXED)
    const completions = trace.events.filter((event) => event.type === 'STAGE_COMPLETED')
    expect(completions.map((event) => event.compoundOperationId)).toEqual([
      'COMPOUND-1',
      'COMPOUND-2',
      'COMPOUND-3',
      undefined,
    ])
    const operations = trace.compound!.operations!
    completions.forEach((event, index) => {
      const view = foldEvents(trace.events, trace.events.indexOf(event))
      expect(view.snapshot).toBe(operations[index]?.snapshot)
      expect(view.completedStageKeys).toContain(
        operations[index]?.snapshot.compoundOperationId ?? 'COMPOUND',
      )
    })

    const graph = buildFlowGraph(trace)
    const before = deriveFlowState(graph, new Set(['COMPOUND-1', 'COMPOUND-2']), null, false)
    expect(before.nodes['op-COMPOUND-1']).toBe('completed')
    expect(before.nodes['op-COMPOUND-2']).toBe('completed')
    expect(before.nodes['op-COMPOUND-3']).toBe('pending')
    expect(before.nodes['data-COMPOUND-3']).toBe('hidden')
    const after = deriveFlowState(
      graph,
      new Set(['COMPOUND-1', 'COMPOUND-2', 'COMPOUND-3', 'COMPOUND']),
      null,
      false,
    )
    expect(after.nodes['op-COMPOUND-3']).toBe('completed')
    expect(after.nodes['op-COMPOUND']).toBe('completed')
  })

  it('keeps empty operation results and first-branch columns inspectable', () => {
    const trace = run('SELECT id AS left_id, v AS label FROM a EXCEPT SELECT id, v FROM a')
    const graph = buildFlowGraph(trace)
    const operation = graph.nodes.find((node) => node.id === 'op-COMPOUND')!
    const inspection = inspectNode(operation, trace)
    expect(inspection.output?.rows).toEqual([])
    expect(inspection.output?.columns).toEqual(['left_id', 'label'])
    expect(trace.finalRows).toEqual([])
  })

  it('marks capped intermediate operations incomplete without changing the real fold', () => {
    const trace = run(MIXED, { maxRows: 2 })
    const operations = trace.compound!.operations!
    expect(operations[0]?.snapshot.truncated).toBe(true)
    expect(operations[0]?.snapshot.incomplete).toBe(true)
    expect(operations[0]?.snapshot.rows.length).toBeLessThanOrEqual(2)
    expect(trace.incomplete).toBe(true)
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [null, 'n'],
      [1, 'one'],
    ])
  })
})
