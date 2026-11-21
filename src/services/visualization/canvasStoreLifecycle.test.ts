import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { splitStatements } from '../../utils/queryHelpers'
import {
  createDatabase,
  getLiveDatabase,
  resetDatabaseManagerForTests,
} from '../database/databaseManager'
import { clearAllDatabaseData } from '../persistence/persistenceService'
import { useDatabaseStore } from '../../store/databaseStore'
import { foldEvents, useVisualizationStore } from '../../store/visualizationStore'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'

beforeEach(async () => {
  resetDatabaseManagerForTests()
  useDatabaseStore.setState({
    status: 'uninitialized',
    initError: null,
    schema: null,
    activeDatabaseId: null,
    databases: [],
    isExecuting: false,
    lastResult: null,
  })
  await clearAllDatabaseData({ includeHistory: true, includeSavedQueries: true })
  await createDatabase({ name: 'Canvas lifecycle', template: 'blank' })
  const live = getLiveDatabase()
  if (live === null) throw new Error('Expected a live database')
  live.runRaw(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, department TEXT);
    INSERT INTO employees VALUES (1, 'Ravi', 'Engineering'), (2, 'Priya', 'Sales'), (3, 'Amit', 'Engineering');
  `)
  useVisualizationStore.getState().resetForDatabaseSwitch()
})

afterEach(() => {
  resetDatabaseManagerForTests()
})

/** Visualize through the real store path the workspace uses. */
function visualize(sql: string) {
  useVisualizationStore.getState().visualize(sql, splitStatements(sql))
  return useVisualizationStore.getState()
}

describe('Canvas graph lifecycle across visualizations', () => {
  it('replaces the previous graph instead of retaining stale nodes', () => {
    const first = visualize("SELECT name FROM employees WHERE department = 'Sales'")
    expect(first.status).toBe('ready')
    const firstGraph = buildFlowGraph(first.trace!)
    expect(firstGraph.nodes.some((node) => node.id === 'op-WHERE')).toBe(true)

    const second = visualize('SELECT name FROM employees ORDER BY name')
    expect(second.status).toBe('ready')
    expect(second.trace).not.toBe(first.trace)
    const secondGraph = buildFlowGraph(second.trace!)
    // The first query's operation no longer exists; the second query's does.
    expect(secondGraph.nodes.some((node) => node.id === 'op-WHERE')).toBe(false)
    expect(secondGraph.nodes.some((node) => node.id === 'data-WHERE')).toBe(false)
    expect(secondGraph.nodes.some((node) => node.id === 'op-ORDER_BY')).toBe(true)
    expect(secondGraph.nodes.filter((node) => node.kind === 'final')).toHaveLength(1)
    // Every node belongs to the new trace's own blocks.
    expect(secondGraph.nodes.every((node) => node.blockId === second.trace!.rootBlockId)).toBe(true)
  })

  it('leaves no partial graph behind when visualization fails', () => {
    const ready = visualize('SELECT name FROM employees ORDER BY name')
    expect(ready.trace).not.toBeNull()

    const failed = visualize('SELECT * FROM missing_table')
    expect(failed.status).toBe('unsupported')
    expect(failed.trace).toBeNull()
    expect(failed.validation).toBeNull()
    expect(failed.viewState.snapshot).toBeNull()
    expect(failed.viewState.activeStage).toBeNull()
    expect(failed.unavailableReasons.length).toBeGreaterThan(0)
  })

  it('seeks through playback without duplicating or reordering graph nodes', () => {
    const state = visualize("SELECT name FROM employees WHERE department = 'Engineering' ORDER BY name")
    const trace = state.trace!
    const graph = buildFlowGraph(trace)
    const nodeIds = graph.nodes.map((node) => node.id)
    const expectedIds = [...nodeIds].sort()

    for (let index = 0; index < trace.events.length; index++) {
      const view = foldEvents(trace.events, index)
      const derived = deriveFlowState(
        graph,
        new Set(view.completedStageKeys),
        view.activeStageKey,
        view.finished,
      )
      // Seeking only derives statuses; it never adds or removes nodes.
      expect(Object.keys(derived.nodes).sort()).toEqual(expectedIds)
      expect(Object.keys(derived.edges).sort()).toEqual(graph.edges.map((edge) => edge.id).sort())
    }

    const start = foldEvents(trace.events, 0)
    const startState = deriveFlowState(graph, new Set(start.completedStageKeys), start.activeStageKey, start.finished)
    expect(startState.nodes.final).not.toBe('completed')

    const end = foldEvents(trace.events, trace.events.length - 1)
    const endState = deriveFlowState(graph, new Set(end.completedStageKeys), end.activeStageKey, end.finished)
    expect(endState.nodes.final).toBe('completed')
    expect(endState.nodes.final).not.toBe('hidden')

    // The graph itself is untouched by any amount of playback.
    expect(graph.nodes.map((node) => node.id)).toEqual(nodeIds)
  })

  it('derives identical state on repeated renders of the same graph', () => {
    const state = visualize('SELECT name FROM employees ORDER BY name')
    const trace = state.trace!
    const graph = buildFlowGraph(trace)
    const layout = JSON.stringify(graph.nodes.map((node) => [node.id, node.x, node.y, node.height]))
    const end = foldEvents(trace.events, trace.events.length - 1)
    const completed = new Set(end.completedStageKeys)

    const first = deriveFlowState(graph, completed, null, true)
    const second = deriveFlowState(graph, completed, null, true)
    expect(second).toEqual(first)
    expect(JSON.stringify(graph.nodes.map((node) => [node.id, node.x, node.y, node.height]))).toBe(layout)
  })
})
