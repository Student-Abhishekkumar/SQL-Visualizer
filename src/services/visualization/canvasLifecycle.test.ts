import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { stageKeyFor } from './queryBlocks'
import { simulateAndValidate } from './validation'
import type { VisualizationTrace, VisualizedStage } from '../../types/visualization'
import type { FlowGraph } from '../../types/flowGraph'

let db: SQLiteDatabase
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, salary INTEGER);
    INSERT INTO employees VALUES (1, 'Ravi', 1, 60000), (2, 'Priya', 2, 50000), (3, 'Amit', 1, 70000);
    CREATE TABLE empty_items (id INTEGER PRIMARY KEY, name TEXT);
  `)
})
afterEach(() => db.close())

export function traceOf(sql: string): VisualizationTrace {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected a visualization trace')
  expect(outcome.validation?.validated).toBe(true)
  return outcome.simulation.trace
}

function expectInvariants(graph: FlowGraph): void {
  const nodeIds = graph.nodes.map((node) => node.id)
  const edgeIds = graph.edges.map((edge) => edge.id)
  expect(new Set(nodeIds).size).toBe(nodeIds.length)
  expect(new Set(edgeIds).size).toBe(edgeIds.length)
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const edge of graph.edges) {
    expect(nodes.has(edge.from), edge.id).toBe(true)
    expect(nodes.has(edge.to), edge.id).toBe(true)
    expect(nodes.get(edge.from)?.sockets.some((socket) => socket.id === edge.fromSocket), edge.id).toBe(true)
    expect(nodes.get(edge.to)?.sockets.some((socket) => socket.id === edge.toSocket), edge.id).toBe(true)
  }
  expect(graph.nodes.filter((node) => node.kind === 'final')).toHaveLength(1)
}

function operations(graph: FlowGraph): VisualizedStage[] {
  return graph.nodes.filter((node) => node.kind === 'operation').map((node) => node.stage)
    .filter((stage): stage is VisualizedStage => stage !== null)
}

describe('trace-driven Canvas node lifecycle', () => {
  it.each([
    ['SELECT * FROM employees', ['SELECT']],
    ['SELECT name FROM employees WHERE department_id = 2', ['WHERE', 'SELECT']],
    ['SELECT department_id, COUNT(*) FROM employees GROUP BY department_id', ['GROUP_BY', 'SELECT']],
    ['SELECT name FROM employees ORDER BY name LIMIT 5', ['SELECT', 'ORDER_BY', 'LIMIT']],
  ] as const)('creates only the actual operations for %s', (sql, expected) => {
    const trace = traceOf(sql)
    const graph = buildFlowGraph(trace)
    expect(operations(graph)).toEqual(expected)
    expect(operations(graph)).toEqual(trace.stages.filter((stage) => stage !== 'FROM'))
    expect(graph.nodes.some((node) => node.id === `data-${trace.stages.at(-1)}`)).toBe(false)
    expectInvariants(graph)
  })

  it('does not create conditional nodes from a generic SELECT pipeline', () => {
    const graph = buildFlowGraph(traceOf('SELECT * FROM employees'))
    for (const stage of ['WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY', 'LIMIT', 'DISTINCT'] as const) {
      expect(graph.nodes.some((node) => node.stage === stage)).toBe(false)
    }
  })

  it.each(['SELECT name FROM employees WHERE department_id = 999', 'SELECT * FROM empty_items'])(
    'treats zero rows as a valid completed result: %s', (sql) => {
      const trace = traceOf(sql)
      const graph = buildFlowGraph(trace)
      const final = graph.nodes.find((node) => node.kind === 'final')
      expect(trace.finalRows).toEqual([])
      expect(final?.rows).toEqual([])
      expect(final?.snapshot).toBe(trace.stageSnapshots.at(-1))
      const completed = new Set(trace.stageSnapshots.map((snapshot) =>
        stageKeyFor(snapshot.blockId, snapshot.stage, trace.rootBlockId, snapshot.compoundOperationId)))
      expect(deriveFlowState(graph, completed, null, true).nodes.final).toBe('completed')
      expectInvariants(graph)
    },
  )

  it('is deterministic and derives nodes from snapshots rather than stage names', () => {
    const trace = traceOf('SELECT name FROM employees ORDER BY name LIMIT 2')
    const first = buildFlowGraph(trace)
    expect(buildFlowGraph(trace)).toEqual(first)
    const snapshotDriven = buildFlowGraph({ ...trace, stages: [] })
    expect(snapshotDriven.nodes).toEqual(first.nodes)
    expect(snapshotDriven.edges).toEqual(first.edges)
  })

  it('does not fabricate a final result without a terminal snapshot', () => {
    const trace = traceOf('SELECT * FROM employees')
    const graph = buildFlowGraph({ ...trace, stages: [], stageSnapshots: [], events: [], totalSteps: 0 })
    expect(graph.nodes.some((node) => node.kind === 'final')).toBe(false)
    expect(graph.nodes.some((node) => node.kind === 'operation' || node.kind === 'data')).toBe(false)
  })
})
