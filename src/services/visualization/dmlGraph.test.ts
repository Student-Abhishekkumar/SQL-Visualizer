import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { inspectNode } from './nodeInspection'
import { traceUpstreamPath } from './flowPath'
import { foldEvents } from '../../store/visualizationStore'
import type { VisualizationTrace } from '../../types/visualization'

let db: SQLiteDatabase
beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, grp INTEGER); INSERT INTO items VALUES (1, 'a', 1), (2, 'b', 1), (3, 'c', 2)")
})
afterEach(() => db.close())

function traceOf(sql: string): VisualizationTrace {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected DML trace')
  expect(outcome.validation?.validated).toBe(true)
  return outcome.simulation.trace
}

describe('DML flow graph, inspector and playback', () => {
  it.each([
    ["INSERT INTO items (id, name, grp) VALUES (4, 'd', 3)", 'INSERT'],
    ["UPDATE items SET grp = 3 WHERE id = 1", 'SET'],
    ['DELETE FROM items WHERE id = 1', 'DELETE'],
  ] as const)('connects the real target source through %s', (sql, operationStage) => {
    const trace = traceOf(sql)
    const graph = buildFlowGraph(trace)
    const source = graph.nodes.find((node) => node.kind === 'source')
    expect(source?.stage).toBe('TARGET')
    expect(source?.table?.previewRows).toHaveLength(3)
    expect(graph.nodes.some((node) => node.stage === operationStage)).toBe(true)
    expect(graph.edges.some((edge) => edge.from === source?.id && edge.to === 'data-TARGET')).toBe(true)

    const upstream = traceUpstreamPath(graph, 'final')
    expect(upstream.nodeIds.has(source?.id ?? '')).toBe(true)
    expect(upstream.nodeIds.has('branch-MATCHED_ROWS')).toBe(false)
    expect(graph.nodes.find((node) => node.id === 'final')?.label).toBe('Final table')
  })

  it('shows real SET input/output snapshots and the isolated final table', () => {
    const trace = traceOf("UPDATE items SET grp = 3, name = 'changed' WHERE id = 1")
    const graph = buildFlowGraph(trace)
    const setNode = graph.nodes.find((node) => node.id === 'data-SET')
    expect(setNode).toBeDefined()
    if (setNode === undefined) return
    const inspection = inspectNode(setNode, trace)
    expect(inspection.inputs[0]?.rows.map((row) => row.values)).toEqual([[1, 'a', 1]])
    expect(inspection.output?.rows.map((row) => row.values)).toEqual([[1, 'changed', 3]])
    const finalNode = graph.nodes.find((node) => node.id === 'final')
    expect(finalNode).toBeDefined()
    if (finalNode === undefined) return
    expect(inspectNode(finalNode, trace).header.title).toBe('Final table (isolated preview)')
    expect(inspectNode(finalNode, trace).output?.rows).toHaveLength(3)
  })

  it('folds DML events and reveals stages through the existing playback state', () => {
    const trace = traceOf('UPDATE items SET grp = 3 WHERE id = 1')
    const graph = buildFlowGraph(trace)
    const setIndex = trace.events.findIndex((event) => event.type === 'STAGE_COMPLETED' && event.stage === 'SET')
    const view = foldEvents(trace.events, setIndex)
    expect(view.snapshot?.stage).toBe('SET')
    expect(view.completedStageKeys).toEqual(['TARGET', 'MATCHED_ROWS', 'SET'])
    const state = deriveFlowState(graph, new Set(view.completedStageKeys), view.activeStageKey, view.finished)
    expect(state.nodes['data-SET']).toBe('completed')
    expect(state.nodes['data-CHANGED_ROWS']).toBe('hidden')
    expect(state.nodes['src-0-items']).toBe('completed')
    const end = foldEvents(trace.events, trace.events.length - 1)
    expect(end.finished).toBe(true)
    expect(end.snapshot?.stage).toBe('FINAL_TABLE')
    expect(end.snapshot?.rows).toEqual(trace.finalRows)
  })
})
