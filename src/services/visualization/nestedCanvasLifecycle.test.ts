import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { stageKeyFor } from './queryBlocks'
import { simulateAndValidate } from './validation'
import type { VisualizationTrace } from '../../types/visualization'

let db: SQLiteDatabase
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department_id INTEGER, salary INTEGER);
    INSERT INTO employees VALUES (1, 'Ravi', 1, 60000), (2, 'Priya', 2, 50000), (3, 'Amit', 1, 70000);
    CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO departments VALUES (1, 'Engineering'), (2, 'Sales');
    CREATE TABLE empty_items (id INTEGER PRIMARY KEY);
  `)
})
afterEach(() => db.close())

function traceOf(sql: string): VisualizationTrace {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected a visualization trace')
  expect(outcome.validation?.validated).toBe(true)
  return outcome.simulation.trace
}

function expectUniqueIds(graph: ReturnType<typeof buildFlowGraph>): void {
  const ids = graph.nodes.map((node) => node.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(graph.nodes.filter((node) => node.kind === 'final')).toHaveLength(1)
}

describe('nested and compound Canvas identity', () => {
  it('preserves independent nested block identities without duplicate nodes', () => {
    const trace = traceOf(`SELECT name FROM employees
      WHERE salary > (SELECT AVG(salary) FROM employees WHERE salary > 1000)
        AND department_id IN (SELECT id FROM departments WHERE id = 1)`)
    const graph = buildFlowGraph(trace)
    expect(trace.nestedQueries).toHaveLength(2)
    for (const block of trace.nestedQueries ?? []) {
      expect(graph.nodes.some((node) => node.id === `${block.id}-op-WHERE`)).toBe(true)
      expect(graph.nodes.some((node) => node.id === `${block.id}-data-SELECT`)).toBe(true)
    }
    expectUniqueIds(graph)
  })

  it('keeps compound operations distinct and represents the terminal result once', () => {
    const trace = traceOf(`SELECT id FROM employees
      UNION ALL SELECT id FROM departments
      INTERSECT SELECT id FROM employees
      EXCEPT SELECT id FROM empty_items`)
    const graph = buildFlowGraph(trace)
    expect(trace.compound?.operations).toHaveLength(3)
    expect(graph.nodes.filter((node) => node.kind === 'operation' && node.stage === 'COMPOUND').map((node) => node.id)).toEqual([
      'op-COMPOUND-1', 'op-COMPOUND-2', 'op-COMPOUND',
    ])
    expect(graph.nodes.some((node) => node.id === 'data-COMPOUND')).toBe(false)
    expectUniqueIds(graph)
  })

  it('does not complete the root final node when only a nested block finishes', () => {
    const trace = traceOf('SELECT name FROM employees WHERE department_id IN (SELECT id FROM departments)')
    const block = trace.nestedQueries?.[0]
    expect(block).toBeDefined()
    if (block === undefined) return
    const graph = buildFlowGraph(trace)
    const completed = new Set(block.stageSnapshots.map((snapshot) =>
      stageKeyFor(block.id, snapshot.stage, trace.rootBlockId)))
    const state = deriveFlowState(graph, completed, null, true)
    expect(state.nodes[`${block.id}-data-SELECT`]).toBe('completed')
    expect(state.nodes.final).toBe('pending')
  })
})
