import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHistoryStore } from './historyStore'
import {
  clearHistory,
  clearSavedQueries,
  loadHistory,
  loadSavedQueries,
} from '../services/persistence/persistenceService'
import type { HistoryEntry, QueryExecutionResult } from '../types/query'

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

function makeHistoryEntry(index: number): HistoryEntry {
  return {
    id: `history-${index}`,
    sql: `SELECT ${index}`,
    timestamp: index,
    success: true,
    executionTime: index / 10,
    rowCount: index,
    statementType: 'SELECT',
    databaseId: index % 2 === 0 ? 'database-even' : 'database-odd',
  }
}

/** Seed legacy overflow directly, bypassing the new capped write API. */
async function seedHistory(entries: readonly HistoryEntry[]): Promise<void> {
  const request = indexedDB.open('sql-visualizer')
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = db.transaction('history', 'readwrite')
  const store = transaction.objectStore('history')
  for (const entry of entries) store.put(entry)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  db.close()
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

afterEach(() => {
  vi.restoreAllMocks()
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

  it('persists only the newest 200 entries and preserves their metadata', async () => {
    const writes: Promise<void>[] = []
    for (let index = 1; index <= 205; index += 1) {
      writes.push(useHistoryStore.getState().recordExecution(makeResult({
        query: `SELECT ${index}`,
        databaseId: index % 2 === 0 ? 'database-even' : 'database-odd',
        executionTime: index / 10,
        rowCount: index,
      })))
    }
    await Promise.all(writes)

    const history = useHistoryStore.getState().history
    expect(history).toHaveLength(200)
    expect(history[0]?.sql).toBe('SELECT 205')
    expect(history[199]?.sql).toBe('SELECT 6')

    const persisted = await loadHistory()
    expect(persisted).toHaveLength(200)
    expect(persisted.map((entry) => entry.sql)).toEqual(history.map((entry) => entry.sql))
    for (const entry of persisted) {
      const index = Number(entry.sql.replace('SELECT ', ''))
      expect(entry.databaseId).toBe(index % 2 === 0 ? 'database-even' : 'database-odd')
      expect(entry.executionTime).toBe(index / 10)
      expect(entry.rowCount).toBe(index)
    }
  })

  it('trims legacy overflow during hydration without rewriting valid data on reload', async () => {
    await seedHistory(Array.from({ length: 205 }, (_, index) => makeHistoryEntry(index + 1)))
    const deleteSpy = vi.spyOn(IDBObjectStore.prototype, 'delete')

    await useHistoryStore.getState().loadFromStorage()
    expect(deleteSpy).toHaveBeenCalledTimes(5)
    expect(useHistoryStore.getState().history.map((entry) => entry.timestamp)).toEqual(
      Array.from({ length: 200 }, (_, index) => 205 - index),
    )
    expect(useHistoryStore.getState().history[0]?.databaseId).toBe('database-odd')

    useHistoryStore.setState({ history: [], loaded: false })
    deleteSpy.mockClear()
    await useHistoryStore.getState().loadFromStorage()
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(useHistoryStore.getState().history).toHaveLength(200)
    expect(useHistoryStore.getState().history[0]?.sql).toBe('SELECT 205')
    expect(useHistoryStore.getState().history[199]?.sql).toBe('SELECT 6')
    expect(await loadHistory()).toHaveLength(200)
  })

  it('merges entries recorded during and immediately after hydration', async () => {
    await seedHistory([makeHistoryEntry(1)])
    const hydration = useHistoryStore.getState().loadFromStorage()
    const during = useHistoryStore.getState().recordExecution(makeResult({
      query: 'SELECT during hydration',
      databaseId: 'database-live',
    }))
    await Promise.all([hydration, during])

    expect(useHistoryStore.getState().history.map((entry) => entry.sql)).toEqual([
      'SELECT during hydration',
      'SELECT 1',
    ])
    await useHistoryStore.getState().recordExecution(makeResult({ query: 'SELECT after hydration' }))
    expect(useHistoryStore.getState().history.map((entry) => entry.sql)).toEqual([
      'SELECT after hydration',
      'SELECT during hydration',
      'SELECT 1',
    ])

    useHistoryStore.setState({ history: [], loaded: false })
    await useHistoryStore.getState().loadFromStorage()
    expect(useHistoryStore.getState().history.map((entry) => entry.sql)).toEqual([
      'SELECT after hydration',
      'SELECT during hydration',
      'SELECT 1',
    ])
    expect(useHistoryStore.getState().history[1]?.databaseId).toBe('database-live')
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
