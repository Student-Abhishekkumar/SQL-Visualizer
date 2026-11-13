import {
  clearDatabaseSnapshot,
  loadDatabaseSnapshot,
  saveDatabaseSnapshot,
} from '../persistence/persistenceService'
import {
  SCHEMA_SQL,
  SEED_SQL,
  UNIVERSITY_DB_NAME,
} from './seedData'
import { getDatabaseSchema } from './schemaService'
import { SQLiteDatabase } from './sqliteService'
import type { DatabaseSchema } from '../../types/database'

/**
 * Database lifecycle: initialize (restore or seed), reset, and keep a
 * module-level reference to the live connection so consecutive queries
 * reuse the same database session.
 *
 * The browser passes a WASM locateFile config; test and worker hosts
 * can pass their own.
 */

export type SqlJsConfig = Parameters<typeof SQLiteDatabase.create>[0]

let liveDatabase: SQLiteDatabase | null = null

/** The currently open database, or null before initialization. */
export function getLiveDatabase(): SQLiteDatabase | null {
  return liveDatabase
}

export interface InitializeResult {
  db: SQLiteDatabase
  /** True when an existing snapshot was restored instead of seeded. */
  restored: boolean
  schema: DatabaseSchema
}

/**
 * Initialize the WASM SQLite engine:
 *  1. Restore the persisted snapshot when available.
 *  2. Otherwise create a fresh University Database with seed data.
 * The result is cached — repeated calls return the same connection.
 */
export async function initializeDatabase(
  config?: SqlJsConfig,
): Promise<InitializeResult> {
  if (liveDatabase) {
    return {
      db: liveDatabase,
      restored: true,
      schema: getDatabaseSchema(liveDatabase, UNIVERSITY_DB_NAME),
    }
  }

  const snapshot = await loadDatabaseSnapshot()
  if (snapshot) {
    try {
      const db = await SQLiteDatabase.create(config, snapshot)
      liveDatabase = db
      return {
        db,
        restored: true,
        schema: getDatabaseSchema(db, UNIVERSITY_DB_NAME),
      }
    } catch {
      // Corrupt snapshot — fall through to a fresh seed below.
      await clearDatabaseSnapshot()
    }
  }

  const db = await SQLiteDatabase.create(config)
  db.runRaw(SCHEMA_SQL)
  db.runRaw(SEED_SQL)
  await saveDatabaseSnapshot(db.exportSnapshot())
  liveDatabase = db
  return {
    db,
    restored: false,
    schema: getDatabaseSchema(db, UNIVERSITY_DB_NAME),
  }
}

/**
 * Replace the live database with a fresh, seeded University Database.
 * Returns the new schema. Throws when reset fails (caller shows UI).
 */
export async function resetDatabase(config?: SqlJsConfig): Promise<DatabaseSchema> {
  const db = await SQLiteDatabase.create(config)
  db.runRaw(SCHEMA_SQL)
  db.runRaw(SEED_SQL)
  await saveDatabaseSnapshot(db.exportSnapshot())

  liveDatabase?.close()
  liveDatabase = db
  return getDatabaseSchema(db, UNIVERSITY_DB_NAME)
}

/**
 * Persist the current database state after mutating statements.
 * Fire-and-forget: persistence failures are non-fatal (the session
 * stays usable; only refresh would lose the change).
 */
export async function persistDatabase(db: SQLiteDatabase): Promise<void> {
  await saveDatabaseSnapshot(db.exportSnapshot())
}

/** Close the live connection (used by tests and hot reloads). */
export function closeDatabase(): void {
  liveDatabase?.close()
  liveDatabase = null
}
