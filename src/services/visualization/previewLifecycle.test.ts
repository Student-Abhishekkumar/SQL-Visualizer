import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { stageKeyFor } from './queryBlocks'
import { simulateAndValidate } from './validation'
import type { VisualizationTrace, VisualizedStage } from '../../types/visualization'

let db: SQLiteDatabase
let activeBytes: Uint8Array

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO items VALUES (1, 'one'), (2, 'two');
    CREATE TABLE seed (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO seed VALUES (3, 'three');
    CREATE INDEX items_name ON items(name);
  `)
  activeBytes = db.exportSnapshot()
})

afterEach(() => db.close())

function traceOf(sql: string): VisualizationTrace {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected an isolated preview trace')
  expect(outcome.validation?.validated).toBe(true)
  expect(db.exportSnapshot()).toEqual(activeBytes)
  return outcome.simulation.trace
}

function expectTerminalLifecycle(trace: VisualizationTrace, operations: VisualizedStage[]): void {
  const graph = buildFlowGraph(trace)
  // The DML target table is a real input, not an operation: it is represented
  // once as the target source plus its TARGET rows node, and must not be
  // duplicated as an operation node.
  const expectedOperations =
    trace.dml !== undefined ? operations.filter((stage) => stage !== 'TARGET') : operations
  expect(graph.nodes.filter((node) => node.kind === 'operation').map((node) => node.stage)).toEqual(expectedOperations)
  if (trace.dml !== undefined) {
    expect(graph.nodes.some((node) => node.kind === 'source' && node.stage === 'TARGET')).toBe(true)
    expect(graph.nodes.some((node) => node.id === 'data-TARGET')).toBe(true)
    expect(graph.nodes.some((node) => node.kind === 'operation' && node.stage === 'TARGET')).toBe(false)
  }
  expect(graph.nodes.filter((node) => node.kind === 'final')).toHaveLength(1)
  expect(graph.nodes.some((node) => node.id === `data-${trace.stages.at(-1)}`)).toBe(false)
  const completed = new Set(trace.stageSnapshots.map((snapshot) => stageKeyFor(snapshot.blockId, snapshot.stage, trace.rootBlockId)))
  const state = deriveFlowState(graph, completed, null, true)
  expect(state.nodes.final).toBe('completed')
  expect(graph.nodes.find((node) => node.id === 'final')?.rows).toEqual(trace.finalRows)
  const ids = graph.nodes.map((node) => node.id)
  expect(new Set(ids).size).toBe(ids.length)
}

describe('DML Canvas lifecycle and zero-change completion', () => {
  it('completes zero-row INSERT SELECT without fabricating input or inserted rows', () => {
    const trace = traceOf('INSERT INTO items (id, name) SELECT id, name FROM seed WHERE id = 999')
    expect(trace.dml?.affectedRowCount).toBe(0)
    expect(trace.stageSnapshots.find((snapshot) => snapshot.stage === 'INPUT')?.rows).toEqual([])
    expect(trace.stageSnapshots.find((snapshot) => snapshot.stage === 'INSERT')?.rows).toEqual([])
    expectTerminalLifecycle(trace, ['TARGET', 'INPUT', 'COLUMN_MAPPING', 'INSERT', 'FINAL_TABLE'])
  })

  it('distinguishes a matched-but-unchanged UPDATE while still completing', () => {
    const trace = traceOf("UPDATE items SET name = 'one' WHERE id = 1")
    expect(trace.dml?.matchedRowIds).toHaveLength(1)
    expect(trace.dml?.changedRowIds).toEqual([])
    expect(trace.dml?.unchangedRowIds).toHaveLength(1)
    expectTerminalLifecycle(trace, ['TARGET', 'MATCHED_ROWS', 'SET', 'CHANGED_ROWS', 'UNCHANGED_ROWS', 'FINAL_TABLE'])
  })

  it.each([
    ["UPDATE items SET name = 'missing' WHERE id = 999", ['TARGET', 'MATCHED_ROWS', 'SET', 'CHANGED_ROWS', 'UNCHANGED_ROWS', 'FINAL_TABLE']],
    ['DELETE FROM items WHERE id = 999', ['TARGET', 'MATCHED_ROWS', 'DELETE', 'RETAINED_ROWS', 'FINAL_TABLE']],
  ] as const)('completes a zero-match mutation with only its real stages: %s', (sql, stages) => {
    const trace = traceOf(sql)
    expect(trace.dml?.affectedRowCount).toBe(0)
    expectTerminalLifecycle(trace, [...stages])
  })
})

describe('DDL Canvas lifecycle and existence-clause no-ops', () => {
  it.each([
    ['CREATE TABLE IF NOT EXISTS items (other TEXT)', ['DATABASE', 'TABLE_DEFINITION', 'COLUMN_DEFINITIONS', 'CONSTRAINTS', 'CREATE_TABLE', 'RESULTING_SCHEMA']],
    ['CREATE INDEX IF NOT EXISTS items_name ON items(name)', ['DATABASE', 'INDEX_DEFINITION', 'CREATE_INDEX', 'INDEX_METADATA']],
    ['DROP TABLE IF EXISTS missing_items', ['ORIGINAL_SCHEMA', 'DROP_TABLE', 'REMOVED_TABLE', 'REMAINING_SCHEMA']],
    ['DROP INDEX IF EXISTS missing_index', ['EXISTING_INDEX', 'DROP_INDEX', 'REMAINING_INDEXES']],
  ] as const)('represents a no-op as completed without an extra terminal node: %s', (sql, stages) => {
    const trace = traceOf(sql)
    expect(trace.ddl?.noOp).toBe(true)
    expectTerminalLifecycle(trace, [...stages])
  })

  it.each([
    ['CREATE TABLE added (id INTEGER PRIMARY KEY, label TEXT)', 'CREATE_TABLE'],
    ["ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'new'", 'ALTER_OPERATION'],
    ['ALTER TABLE items RENAME COLUMN name TO label', 'ALTER_OPERATION'],
    ['ALTER TABLE items RENAME TO renamed_items', 'ALTER_OPERATION'],
    ['DROP TABLE seed', 'DROP_TABLE'],
    ['CREATE UNIQUE INDEX added_unique ON items(name)', 'CREATE_INDEX'],
    ['DROP INDEX items_name', 'DROP_INDEX'],
  ] as const)('uses the actual schema stages for %s', (sql, operation) => {
    const trace = traceOf(sql)
    expect(trace.stages).toContain(operation)
    expectTerminalLifecycle(trace, trace.stages)
  })
})
