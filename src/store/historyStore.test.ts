import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { useHistoryStore } from './historyStore'
import {
  clearHistory,
  clearSavedQueries,
  loadHistory,
  loadSavedQueries,
} from '../services/persistence/persistenceService'
import type { QueryExecutionResult } from '../types/query'

/**
 * History/saved-query behavior with a real (fake-indexeddb) IndexedDB,
 * proving persistence across simulated refreshes.
 */

function makeResult(overrides: Partial<QueryExecutionResult> = {}): QueryExecutionResult {
  return {
    success: true,
    query: 'SELECT 1',
    columns: ['1'],
    rows: [{ '1': 1 }],
    rowCount: 1,
    executionTime: 2,
    statementType: 'SELECT',
    statements: [],
    ...overrides,
  }
}

beforeEach(async () => {
  // Reset the module state and underlying storage between tests.
  useHistoryStore.setState({
    history: [],
    savedQueries: [],
    loaded: false,
  })
  await clearHistory()
  await clearSavedQueries()
})

describe('historyStore', () => {
  it('records executions and exposes them newest-first', () => {
    const store = useHistoryStore.getState()
    store.recordExecution(makeResult({ query: 'SELECT 1' }))
    store.recordExecution(makeResult({ query: 'SELECT 2', statementType: 'SELECT' }))

    const history = useHistoryStore.getState().history
    expect(history).toHaveLength(2)
    expect(history[0]?.sql).toBe('SELECT 2')
    expect(history[1]?.sql).toBe('SELECT 1')
  })

  it('keeps failure entries with their error status', () => {
    useHistoryStore
      .getState()
      .recordExecution(makeResult({ success: false, rowCount: 0, error: 'boom' }))
    const entry = useHistoryStore.getState().history[0]
    expect(entry?.success).toBe(false)
    expect(entry?.rowCount).toBe(0)
  })

  it('persists entries so a "refresh" reloads them from IndexedDB', async () => {
    useHistoryStore.getState().recordExecution(makeResult({ query: 'SELECT 42' }))

    // Simulate reload: re-read from storage.
    const restored = await loadHistory()
    expect(restored).toHaveLength(1)
    expect(restored[0]?.sql).toBe('SELECT 42')

    // And the store hydrates from storage.
    await useHistoryStore.getState().loadFromStorage()
    expect(useHistoryStore.getState().history[0]?.sql).toBe('SELECT 42')
  })

  it('deletes single entries and clears everything', async () => {
    const store = useHistoryStore.getState()
    store.recordExecution(makeResult({ query: 'SELECT 1' }))
    store.recordExecution(makeResult({ query: 'SELECT 2' }))

    const firstId = useHistoryStore.getState().history[0]?.id as string
    await store.removeHistoryEntry(firstId)
    expect(useHistoryStore.getState().history).toHaveLength(1)
    expect(await loadHistory()).toHaveLength(1)

    await store.clearAllHistory()
    expect(useHistoryStore.getState().history).toHaveLength(0)
    expect(await loadHistory()).toHaveLength(0)
  })
})

describe('saved queries', () => {
  it('saves, reloads after refresh and deletes', async () => {
    const store = useHistoryStore.getState()
    await store.addSavedQuery('My query', 'SELECT 7')

    // Simulate reload.
    const restored = await loadSavedQueries()
    expect(restored).toHaveLength(1)
    expect(restored[0]?.name).toBe('My query')
    expect(restored[0]?.sql).toBe('SELECT 7')

    await useHistoryStore.getState().loadFromStorage()
    const id = useHistoryStore.getState().savedQueries[0]?.id as string
    await useHistoryStore.getState().removeSavedQuery(id)
    expect(await loadSavedQueries()).toHaveLength(0)
  })

  it('falls back to a default name for empty names', async () => {
    await useHistoryStore.getState().addSavedQuery('   ', 'SELECT 7')
    const saved = useHistoryStore.getState().savedQueries[0]
    expect(saved?.name).toBe('Untitled query')
  })
})
