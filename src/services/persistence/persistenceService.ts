import {
  openDB,
  type IDBPDatabase,
  type IDBPTransaction,
} from 'idb'
import type { DatabaseInfo } from '../../types/database'
import type { HistoryEntry, SavedQuery } from '../../types/query'
import { UNIVERSITY_DB_NAME } from '../database/seedData'

/**
 * Browser persistence on top of IndexedDB.
 *
 * v2 stores (one workspace, many independent databases):
 *  - databases : persistent metadata records (DatabaseInfo)
 *  - snapshots : serialized SQLite bytes, keyed by database id
 *  - app       : small key/value app state (active database id)
 *  - history   : executed query log (results are never stored)
 *  - queries   : user-saved named queries
 *
 * The v1 `database` store is kept untouched so an upgrade can migrate
 * its single snapshot into a proper database record without losing data.
 *
 * All operations degrade gracefully (return null/[]) when IndexedDB is
 * unavailable (private mode, test environments).
 */

const DB_NAME = 'sql-visualizer'
const DB_VERSION = 2

const STORE_DATABASE = 'database'
const STORE_HISTORY = 'history'
const STORE_QUERIES = 'queries'

const STORE_DATABASES = 'databases'
const STORE_SNAPSHOTS = 'snapshots'
const STORE_APP = 'app'

export const ACTIVE_DATABASE_KEY = 'activeDatabaseId'
const LEGACY_MIGRATED_KEY = 'legacyWorkspaceMigrated'

/** Stable id used when migrating the v1 single-snapshot database. */
export const LEGACY_DATABASE_ID = 'legacy-university'

let dbPromise: Promise<IDBPDatabase> | null = null

function getDb(): Promise<IDBPDatabase> | null {
  if (typeof indexedDB === 'undefined') return null
  if (dbPromise !== null) return dbPromise

  let attempt: Promise<IDBPDatabase>
  try {
    attempt = openDB(DB_NAME, DB_VERSION, {
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

        if (!database.objectStoreNames.contains(STORE_DATABASES)) {
          database.createObjectStore(STORE_DATABASES, { keyPath: 'id' })
        }
        if (!database.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          database.createObjectStore(STORE_SNAPSHOTS)
        }
        if (!database.objectStoreNames.contains(STORE_APP)) {
          database.createObjectStore(STORE_APP, { keyPath: 'key' })
        }
      },
    }).then(async (database) => {
      // Migration runs after the version-change transaction commits so we
      // can use idb's promise API for cursor-independent, idempotent work.
      try {
        await migrateLegacyWorkspace(database)
        return database
      } catch (error) {
        database.close()
        throw error
      }
    })
  } catch (error) {
    dbPromise = null
    throw error
  }

  dbPromise = attempt
  // A rejected attempt must not poison later retries. The identity check
  // prevents an old rejection from clearing a newer initialization attempt.
  void attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null
  })
  return attempt
}

/**
 * Move the v1 `database/current` snapshot into a `databases` record +
 * `snapshots` entry and tag legacy history/saved queries with that id.
 * Idempotent: guarded by an app-state marker so deleting every database
 * never resurrects the legacy snapshot.
 */
async function migrateLegacyWorkspace(db: IDBPDatabase): Promise<void> {
  try {
    const marker = (await db.get(STORE_APP, LEGACY_MIGRATED_KEY)) as
      | { key: string; value: boolean }
      | undefined
    if (marker?.value === true) return

    // Existing v2 records mean this workspace is already migrated.
    if ((await db.count(STORE_DATABASES)) > 0) {
      await db.put(STORE_APP, { key: LEGACY_MIGRATED_KEY, value: true })
      return
    }

    const bytes = (await db.get(STORE_DATABASE, 'current')) as Uint8Array | undefined
    const transaction = db.transaction(
      [STORE_DATABASES, STORE_SNAPSHOTS, STORE_APP, STORE_HISTORY, STORE_QUERIES],
      'readwrite',
    )

    if (bytes instanceof Uint8Array && bytes.byteLength > 0) {
      const now = Date.now()
      const record: DatabaseInfo = {
        id: LEGACY_DATABASE_ID,
        name: UNIVERSITY_DB_NAME,
        description: 'Restored from the previous SQL Visualizer session.',
        template: 'example',
        createdAt: now,
        updatedAt: now,
        // Accurate stats are refreshed the first time the database is opened.
        tableCount: 0,
        rowCount: 0,
        sizeBytes: bytes.byteLength,
      }

      await transaction.objectStore(STORE_DATABASES).put(record)
      await transaction.objectStore(STORE_SNAPSHOTS).put(bytes, LEGACY_DATABASE_ID)
      await transaction.objectStore(STORE_APP).put({
        key: ACTIVE_DATABASE_KEY,
        value: LEGACY_DATABASE_ID,
      })

      await tagLegacyRows(transaction, STORE_HISTORY, LEGACY_DATABASE_ID)
      await tagLegacyRows(transaction, STORE_QUERIES, LEGACY_DATABASE_ID)
    }

    await transaction.objectStore(STORE_APP).put({
      key: LEGACY_MIGRATED_KEY,
      value: true,
    })
    await transaction.done
  } catch (error) {
    throw new Error('IndexedDB workspace migration failed; saved data was not replaced.', {
      cause: error,
    })
  }
}

/** Add `databaseId` to persisted rows created before v2. */
async function tagLegacyRows(
  transaction: IDBPTransaction<unknown, string[], 'readwrite'>,
  storeName: string,
  id: string,
): Promise<void> {
  const store = transaction.objectStore(storeName)
  const rows = (await store.getAll()) as Array<Record<string, unknown>>
  await Promise.all(
    rows
      .filter((row) => row.databaseId === undefined)
      .map((row) => store.put({ ...row, databaseId: id })),
  )
}

// --------------------------- Database metadata ----------------------------

export async function loadDatabaseRecords(): Promise<DatabaseInfo[]> {
  const db = await getDb()
  if (!db) return []
  try {
    const records = (await db.getAll(STORE_DATABASES)) as DatabaseInfo[]
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch (error) {
    throw new Error('Could not read saved database metadata from IndexedDB.', { cause: error })
  }
}

export async function saveDatabaseRecord(record: DatabaseInfo): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.put(STORE_DATABASES, record)
    return true
  } catch {
    return false
  }
}

export async function deleteDatabaseRecord(id: string): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.delete(STORE_DATABASES, id)
    return true
  } catch {
    return false
  }
}

// --------------------------- Database snapshots ---------------------------

export async function loadDatabaseSnapshot(id: string): Promise<Uint8Array | null> {
  const db = await getDb()
  if (!db) return null
  try {
    const value = (await db.get(STORE_SNAPSHOTS, id)) as Uint8Array | undefined
    return value ?? null
  } catch (error) {
    throw new Error(`Could not read the stored snapshot for database "${id}" from IndexedDB.`, {
      cause: error,
    })
  }
}

export async function saveDatabaseSnapshot(
  bytes: Uint8Array,
  id: string,
): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.put(STORE_SNAPSHOTS, bytes, id)
    return true
  } catch {
    return false
  }
}

export async function deleteDatabaseSnapshot(id: string): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.delete(STORE_SNAPSHOTS, id)
    return true
  } catch {
    return false
  }
}

// ----------------------------- App state ----------------------------------

export async function loadActiveDatabaseId(): Promise<string | null> {
  const db = await getDb()
  if (!db) return null
  try {
    const record = (await db.get(STORE_APP, ACTIVE_DATABASE_KEY)) as
      | { key: string; value: string | null }
      | undefined
    return typeof record?.value === 'string' ? record.value : null
  } catch (error) {
    throw new Error('Could not read the active database selection from IndexedDB.', { cause: error })
  }
}

export async function saveActiveDatabaseId(id: string | null): Promise<boolean> {
  const db = await getDb()
  if (!db) return false
  try {
    await db.put(STORE_APP, { key: ACTIVE_DATABASE_KEY, value: id })
    return true
  } catch {
    return false
  }
}

// ------------------------------- History ----------------------------------

export const HISTORY_LIMIT = 200

function compareHistoryEntries(a: HistoryEntry, b: HistoryEntry, preferredId?: string): number {
  const chronological = b.timestamp - a.timestamp
  if (chronological !== 0) return chronological
  // A newly inserted entry wins timestamp ties. Other ties retain IndexedDB's
  // stable key order because older records have no finer-grained ordering.
  if (a.id === preferredId) return -1
  if (b.id === preferredId) return 1
  return 0
}

/** Read newest-first history and delete only actual overflow in one transaction. */
async function readAndTrimHistory(
  db: IDBPDatabase,
  inserted?: HistoryEntry,
): Promise<HistoryEntry[]> {
  const transaction = db.transaction(STORE_HISTORY, 'readwrite')
  const store = transaction.objectStore(STORE_HISTORY)
  if (inserted !== undefined) await store.put(inserted)
  const entries = (await store.getAll()) as HistoryEntry[]
  entries.sort((a, b) => compareHistoryEntries(a, b, inserted?.id))
  const retained = entries.slice(0, HISTORY_LIMIT)
  const overflow = entries.slice(HISTORY_LIMIT)
  await Promise.all(overflow.map((entry) => store.delete(entry.id)))
  await transaction.done
  return retained
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  const db = await getDb()
  if (!db) return []
  try {
    return await readAndTrimHistory(db)
  } catch {
    return []
  }
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await readAndTrimHistory(db, entry)
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

export async function deleteHistoryForDatabase(databaseId: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE_HISTORY, 'readwrite')
    const store = tx.objectStore(STORE_HISTORY)
    const entries = (await store.getAll()) as HistoryEntry[]
    await Promise.all(
      entries
        .filter((entry) => entry.databaseId === databaseId)
        .map((entry) => store.delete(entry.id)),
    )
    await tx.done
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

// ------------------------------- Test / reset ------------------------------

/**
 * Clear every persisted database record, snapshot and the active-id
 * marker. History and saved queries are left alone unless requested.
 * Intended for tests and a full workspace reset, never normal flows.
 */
export async function clearAllDatabaseData(
  options: { includeHistory?: boolean; includeSavedQueries?: boolean } = {},
): Promise<void> {
  const db = await getDb()
  if (!db) return
  try {
    await Promise.all([
      db.clear(STORE_DATABASES),
      db.clear(STORE_SNAPSHOTS),
      db.clear(STORE_APP),
      db.clear(STORE_DATABASE),
    ])
    if (options.includeHistory) await db.clear(STORE_HISTORY)
    if (options.includeSavedQueries) await db.clear(STORE_QUERIES)
  } catch {
    /* non-fatal */
  }
}

/** Drop the cached IndexedDB connection (tests / hot reload). */
export function closePersistence(): void {
  const pending = dbPromise
  dbPromise = null
  void pending?.then((db) => db.close()).catch(() => undefined)
}
