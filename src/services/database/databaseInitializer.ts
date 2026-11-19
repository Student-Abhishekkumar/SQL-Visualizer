import type { DatabaseSchema } from '../../types/database'
import {
  closeLiveDatabase,
  getLiveDatabase,
  getActiveDatabase,
  initDatabaseManager,
  openDatabase,
  persistActiveDatabase,
  resetDatabase as resetManagedDatabase,
  type SqlJsConfig,
} from './databaseManager'

/**
 * Backwards-compatible database lifecycle facade.
 *
 * The real multi-database logic lives in `databaseManager.ts`; these
 * wrappers keep the historical single-database helpers (used by older
 * tests and the dev bridge) working against the active database.
 *
 * New code should import from `databaseManager` directly.
 */

export type { SqlJsConfig }

export { getLiveDatabase }

export interface InitializeResult {
  db: NonNullable<ReturnType<typeof getLiveDatabase>>
  /** True when an existing snapshot was restored instead of seeded. */
  restored: boolean
  schema: DatabaseSchema
}

/** Initialize the workspace and return the active live connection. */
export async function initializeDatabase(
  config?: SqlJsConfig,
): Promise<InitializeResult> {
  const result = await initDatabaseManager(config)
  const db = getLiveDatabase()
  if (db === null || result.schema === null) {
    throw new Error('No database could be initialized.')
  }
  return { db, restored: result.restored, schema: result.schema }
}

/** Reset the active database to its template state. */
export async function resetDatabase(config?: SqlJsConfig): Promise<DatabaseSchema> {
  return resetManagedDatabase(undefined, config)
}

/** Persist the active database after a mutating statement. */
export async function persistDatabase(
  db: NonNullable<ReturnType<typeof getLiveDatabase>>,
): Promise<boolean> {
  return persistActiveDatabase(db)
}

/** Close the live connection (used by tests and hot reloads). */
export function closeDatabase(): void {
  closeLiveDatabase()
}

/** Open a database by id through the manager. */
export { openDatabase, getActiveDatabase }
