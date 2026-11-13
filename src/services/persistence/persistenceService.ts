import { openDB, type IDBPDatabase } from 'idb'
import type { HistoryEntry, SavedQuery } from '../../types/query'

/**
 * Browser persistence on top of IndexedDB.
 *
 * Three stores:
 *  - database : serialized SQLite snapshot (single record)
 *  - history  : executed query log (results are never stored)
 *  - queries  : user-saved named queries
 *
 * All operations degrade gracefully (return null/[]) when IndexedDB is
 * unavailable (private mode, test environments).
 */

const DB_NAME = 'sql-visualizer'
const DB_VERSION = 1

const STORE_DATABASE = 'database'
const STORE_HISTORY = 'history'
const STORE_QUERIES = 'queries'

let dbPromise: Promise<IDBPDatabase> | null = null

function getDb(): Promise<IDBPDatabase> | null {
  if (typeof indexedDB === 'undefined') return null
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE_DATABASE)) {
          database.createObjectStore(STORE_DATABASE)
        }
        if (!database.objectStoreNames.contains(STORE_HISTORY)) {
          database.createObjectStore(STORE_HISTORY, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(STORE_QUERIES)) {
          database.createObjectStore(STORE_QUERIES, { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}

// ---------------------------- Database snapshot ---------------------------

export async function loadDatabaseSnapshot(): Promise<Uint8Array | null> {
  const db = await getDb()
  if (!db) return null
  try {
    const value = (await db.get(STORE_DATABASE, 'current')) as
      | Uint8Array
      | undefined
    return value ?? null
  } catch {
    return null
  }
}

export async function saveDatabaseSnapshot(bytes: Uint8Array): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.put(STORE_DATABASE, bytes, 'current')
    return true
  } catch {
    return false
  }
}

export async function clearDatabaseSnapshot(): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.delete(STORE_DATABASE, 'current')
    return true
  } catch {
    return false
  }
}

// ------------------------------- History ----------------------------------

export async function loadHistory(): Promise<HistoryEntry[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const entries = (await db.getAll(STORE_HISTORY)) as HistoryEntry[]
    return entries.sort((a, b) => b.timestamp - a.timestamp)
  } catch {
    return []
  }
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.put(STORE_HISTORY, entry)
  } catch {
    /* non-fatal */
  }
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.delete(STORE_HISTORY, id)
  } catch {
    /* non-fatal */
  }
}

export async function clearHistory(): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.clear(STORE_HISTORY)
  } catch {
    /* non-fatal */
  }
}

export async function clearSavedQueries(): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.clear(STORE_QUERIES)
  } catch {
    /* non-fatal */
  }
}

// ---------------------------- Saved queries --------------------------------

export async function loadSavedQueries(): Promise<SavedQuery[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const entries = (await db.getAll(STORE_QUERIES)) as SavedQuery[]
    return entries.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function saveSavedQuery(query: SavedQuery): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.put(STORE_QUERIES, query)
  } catch {
    /* non-fatal */
  }
}

export async function deleteSavedQuery(id: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await db.delete(STORE_QUERIES, id)
  } catch {
    /* non-fatal */
  }
}
