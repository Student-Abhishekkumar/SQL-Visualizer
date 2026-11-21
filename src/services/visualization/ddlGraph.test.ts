import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { inspectNode } from './nodeInspection'
import { traceUpstreamPath } from './flowPath'
import { docsForStage, explainStage } from './explanations'
import { foldEvents } from '../../store/visualizationStore'
import type { VisualizationTrace } from '../../types/visualization'

let db: SQLiteDatabase
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO items VALUES (1, 'one'), (2, 'two');
    CREATE INDEX items_name ON items(name);
  `)
})
afterEach(() => db.close())

function traceOf(sql: string): VisualizationTrace {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected DDL trace')
  expect(outcome.validation?.validated).toBe(true)
  return outcome.simulation.trace
}

describe('DDL flow graph and inspector', () => {
  it.each([
    ['CREATE TABLE added (id INTEGER PRIMARY KEY, label TEXT)', 'CREATE_TABLE', 'Resulting schema'],
    ["ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'new'", 'SCHEMA_TRANSFORMATION', 'Resulting schema'],
    ['DROP TABLE items', 'DROP_TABLE', 'Resulting schema'],
    ['CREATE INDEX added_index ON items(id)', 'CREATE_INDEX', 'Index metadata'],
    ['DROP INDEX items_name', 'DROP_INDEX', 'Remaining indexes'],
  ])('builds connected schema nodes for %s', (sql, operationStage, finalLabel) => {
    const trace = traceOf(sql)
    const graph = buildFlowGraph(trace)
    expect(trace.sourceTables).toEqual([])
    expect(graph.nodes.some((node) => node.id === `op-${operationStage}`)).toBe(true)
    expect(graph.nodes.some((node) => node.id === `data-${operationStage}`)).toBe(true)
    expect(graph.nodes.find((node) => node.id === 'final')?.label).toBe(finalLabel)
    expect(graph.edges.length).toBeGreaterThanOrEqual(trace.stages.length)

    const firstOperation = graph.nodes.find((node) => node.id === `op-${trace.stages[0]}`)
    const upstream = traceUpstreamPath(graph, 'final')
    expect(upstream.nodeIds.has(firstOperation?.id ?? '')).toBe(true)
    const finalNode = graph.nodes.find((node) => node.id === 'final')
    expect(finalNode).toBeDefined()
    if (finalNode === undefined) return
    const inspection = inspectNode(finalNode, trace)
    expect(inspection.header).toMatchObject({ title: 'Schema preview (isolated)', badge: 'preview' })
    expect(inspection.output?.rows).toEqual(trace.finalRows)
    expect(inspection.overview.description).toMatch(/active database.*not modified/i)
  })

  it('inspects actual column metadata rather than query result rows', () => {
    const trace = traceOf('CREATE TABLE added (id INTEGER PRIMARY KEY, label TEXT DEFAULT \'new\')')
    const graph = buildFlowGraph(trace)
    const node = graph.nodes.find((candidate) => candidate.id === 'data-COLUMN_DEFINITIONS')
    expect(node).toBeDefined()
    if (node === undefined) return
    const inspection = inspectNode(node, trace)
    expect(inspection.output?.columns).toEqual([
      'column', 'declared_type', 'affinity', 'not_null', 'pk_position', 'default_sql', 'unique',
    ])
    expect(inspection.output?.rows.map((row) => row.values[0])).toEqual(['id', 'label'])
    expect(inspection.output?.rows[0]?.values).toEqual(['id', 'INTEGER', 'INTEGER', false, 1, null, true])
  })
})

describe('DDL playback and explanations', () => {
  it('reveals schema stages through the existing playback state', () => {
    const trace = traceOf("ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'new'")
    const graph = buildFlowGraph(trace)
    const transformIndex = trace.events.findIndex((event) =>
      event.type === 'STAGE_COMPLETED' && event.stage === 'SCHEMA_TRANSFORMATION')
    const view = foldEvents(trace.events, transformIndex)
    expect(view.snapshot?.stage).toBe('SCHEMA_TRANSFORMATION')
    expect(view.completedStageKeys).toEqual(['ORIGINAL_SCHEMA', 'ALTER_OPERATION', 'SCHEMA_TRANSFORMATION'])
    const state = deriveFlowState(graph, new Set(view.completedStageKeys), view.activeStageKey, view.finished)
    expect(state.nodes['data-SCHEMA_TRANSFORMATION']).toBe('completed')
    // The terminal snapshot is the final node itself, so no duplicate data
    // node is created for RESULTING_SCHEMA and the result stays unrevealed
    // until its own stage completes.
    expect(graph.nodes.some((node) => node.id === 'data-RESULTING_SCHEMA')).toBe(false)
    expect(state.nodes.final).toBe('pending')
    const end = foldEvents(trace.events, trace.events.length - 1)
    expect(end.finished).toBe(true)
    expect(end.snapshot?.stage).toBe('RESULTING_SCHEMA')
    expect(end.snapshot?.schema?.table?.columns.map((column) => column.name)).toEqual(['id', 'name', 'note'])
  })

  it('provides a real observation and SQLite documentation for every DDL stage', () => {
    for (const sql of [
      'CREATE TABLE added (id INTEGER PRIMARY KEY, label TEXT)',
      "ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'new'",
      'DROP TABLE items',
      'CREATE INDEX added_index ON items(id)',
      'DROP INDEX items_name',
    ]) {
      const trace = traceOf(sql)
      for (const snapshot of trace.stageSnapshots) {
        const explanation = explainStage(snapshot.stage, snapshot, 'advanced')
        expect(explanation.title.length).toBeGreaterThan(0)
        expect(explanation.concept.length).toBeGreaterThan(0)
        expect(explanation.observation).not.toMatch(/undefined|NaN/)
        expect(docsForStage(snapshot.stage).length).toBeGreaterThan(0)
      }
    }
  })
})
