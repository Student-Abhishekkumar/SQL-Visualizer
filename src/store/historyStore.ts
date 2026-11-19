import { create } from 'zustand'
import type { HistoryEntry, QueryExecutionResult, SavedQuery } from '../types/query'
import {
  HISTORY_LIMIT,
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
  recordExecution: (result: QueryExecutionResult, databaseId?: string) => Promise<void>
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
    set((state) => {
      // Keep entries recorded while IndexedDB hydration was in flight. The
      // current in-memory entries come first so timestamp ties keep the
      // newest local insertion ahead of older persisted records.
      const byId = new Map<string, HistoryEntry>()
      for (const entry of [...state.history, ...history]) {
        if (!byId.has(entry.id)) byId.set(entry.id, entry)
      }
      return {
        history: [...byId.values()]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, HISTORY_LIMIT),
        savedQueries,
        loaded: true,
      }
    })
  },

  recordExecution: (result, databaseId) => {
    const entry: HistoryEntry = {
      id: newId(),
      sql: result.query,
      timestamp: Math.max(Date.now(), (get().history[0]?.timestamp ?? 0) + 1),
      success: result.success,
      executionTime: result.executionTime,
      rowCount: result.rowCount,
      statementType: result.statementType,
      databaseId: databaseId ?? result.databaseId,
    }
    set((state) => ({
      history: [entry, ...state.history].slice(0, HISTORY_LIMIT),
    }))
    return addHistoryEntry(entry)
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
