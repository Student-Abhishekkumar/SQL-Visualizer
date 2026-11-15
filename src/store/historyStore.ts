import { create } from 'zustand'
import type { HistoryEntry, QueryExecutionResult, SavedQuery } from '../types/query'
import {
  addHistoryEntry,
  clearHistory,
  deleteHistoryEntry,
  deleteSavedQuery,
  loadHistory,
  loadSavedQueries,
  saveSavedQuery,
} from '../services/persistence/persistenceService'

/**
 * Query history and saved queries, persisted to IndexedDB.
 * History stores metadata only — never result sets.
 */

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface HistoryState {
  history: HistoryEntry[]
  savedQueries: SavedQuery[]
  loaded: boolean

  loadFromStorage: () => Promise<void>
  recordExecution: (result: QueryExecutionResult, databaseId?: string) => void
  removeHistoryEntry: (id: string) => Promise<void>
  clearAllHistory: () => Promise<void>
  addSavedQuery: (name: string, sql: string, databaseId?: string) => Promise<SavedQuery>
  removeSavedQuery: (id: string) => Promise<void>
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  history: [],
  savedQueries: [],
  loaded: false,

  loadFromStorage: async () => {
    if (get().loaded) return
    const [history, savedQueries] = await Promise.all([
      loadHistory(),
      loadSavedQueries(),
    ])
    set({ history, savedQueries, loaded: true })
  },

  recordExecution: (result, databaseId) => {
    const entry: HistoryEntry = {
      id: newId(),
      sql: result.query,
      timestamp: Date.now(),
      success: result.success,
      executionTime: result.executionTime,
      rowCount: result.rowCount,
      statementType: result.statementType,
      databaseId: databaseId ?? result.databaseId,
    }
    set((state) => ({
      history: [entry, ...state.history].slice(0, 200),
    }))
    void addHistoryEntry(entry)
  },

  removeHistoryEntry: async (id) => {
    set((state) => ({ history: state.history.filter((entry) => entry.id !== id) }))
    await deleteHistoryEntry(id)
  },

  clearAllHistory: async () => {
    set({ history: [] })
    await clearHistory()
  },

  addSavedQuery: async (name, sql, databaseId) => {
    const query: SavedQuery = {
      id: newId(),
      name: name.trim() || 'Untitled query',
      sql,
      createdAt: Date.now(),
    }
    if (databaseId !== undefined) query.databaseId = databaseId
    set((state) => ({ savedQueries: [query, ...state.savedQueries] }))
    await saveSavedQuery(query)
    return query
  },

  removeSavedQuery: async (id) => {
    set((state) => ({
      savedQueries: state.savedQueries.filter((query) => query.id !== id),
    }))
    await deleteSavedQuery(id)
  },
}))
