import { create } from 'zustand'
import type {
  DatabaseInfo,
  DatabaseSchema,
  DatabaseStatus,
} from '../types/database'
import type { QueryExecutionResult, StatementType } from '../types/query'
import {
  createDatabase as createManagedDatabase,
  deleteDatabase as deleteManagedDatabase,
  duplicateDatabase as duplicateManagedDatabase,
  exportDatabase as exportManagedDatabase,
  exportDatabaseSql as exportManagedDatabaseSql,
  getActiveDatabase,
  getActiveDatabaseId,
  getDatabases,
  getLiveDatabase,
  importDatabase as importManagedDatabase,
  initDatabaseManager,
  openDatabase as openManagedDatabase,
  persistActiveDatabase,
  renameDatabase as renameManagedDatabase,
  resetDatabase as resetManagedDatabase,
  type CreateDatabaseInput,
  type ImportDatabaseInput,
  type SqlJsConfig,
} from '../services/database/databaseManager'
import { getDatabaseSchema } from '../services/database/schemaService'
import { SqlExecutionError, hasExecutableSql } from '../services/database/sqliteService'
import { isMutatingStatementType } from '../services/sql/statementTypes'
import { resetVisualizationForDatabaseSwitch } from './visualizationReset'

/**
 * Database application state: workspace lifecycle, the active live
 * schema, cached metadata for every database and the last result.
 * Every execution resolves the live connection and database id at call
 * time so a stale reference can never target the wrong database.
 */

interface DatabaseState {
  status: DatabaseStatus
  /** Populated when status === 'error'. */
  initError: string | null
  schema: DatabaseSchema | null
  /** Id of the database queries run against, or null when none is open. */
  activeDatabaseId: string | null
  /** Metadata for every known database, most recently used first. */
  databases: DatabaseInfo[]
  isExecuting: boolean
  lastResult: QueryExecutionResult | null

  initialize: (config?: SqlJsConfig) => Promise<void>
  execute: (sql: string) => Promise<QueryExecutionResult>
  refreshSchema: () => void

  openDatabase: (id: string) => Promise<void>
  createDatabase: (input: CreateDatabaseInput) => Promise<DatabaseInfo>
  importDatabase: (input: ImportDatabaseInput) => Promise<DatabaseInfo>
  renameDatabase: (id: string, name: string) => Promise<DatabaseInfo>
  duplicateDatabase: (id: string, name?: string) => Promise<DatabaseInfo>
  deleteDatabase: (id: string) => Promise<void>
  resetDatabase: (id?: string, config?: SqlJsConfig) => Promise<DatabaseSchema>
  exportDatabase: (id?: string) => Promise<Uint8Array>
  exportDatabaseSql: (id?: string) => Promise<{ sql: string; fileName: string }>
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Apply a database switch: refresh metadata, drop stale results/traces. */
function applyActiveDatabase(
  set: (partial: Partial<DatabaseState>) => void,
  schema: DatabaseSchema | null,
  activeDatabaseId: string | null,
): void {
  set({
    status: 'ready',
    initError: null,
    schema,
    activeDatabaseId,
    databases: [...getDatabases()],
    lastResult: null,
  })
  // A trace/results from the previous database must never be shown.
  resetVisualizationForDatabaseSwitch()
}

export const useDatabaseStore = create<DatabaseState>()((set, get) => ({
  status: 'uninitialized',
  initError: null,
  schema: null,
  activeDatabaseId: null,
  databases: [],
  isExecuting: false,
  lastResult: null,

  initialize: async (config) => {
    if (get().status === 'initializing') return
    set({ status: 'initializing', initError: null })
    try {
      const result = await initDatabaseManager(config)
      set({
        status: 'ready',
        schema: result.schema,
        activeDatabaseId: result.activeDatabaseId,
        databases: result.databases,
        initError: null,
      })
      resetVisualizationForDatabaseSwitch()
    } catch (error) {
      set({
        status: 'error',
        initError: messageOf(error, 'Failed to initialize database'),
      })
    }
  },

  execute: async (sql) => {
    const startedAt = performance.now()
    const databaseId = getActiveDatabaseId() ?? undefined

    if (!hasExecutableSql(sql)) {
      const result: QueryExecutionResult = {
        success: false,
        query: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: performance.now() - startedAt,
        statementType: 'UNKNOWN' as StatementType,
        statements: [],
        databaseId,
        error: 'No SQL statement to execute. Write a query or pick an example first.',
        committed: false,
        rolledBack: false,
        persistencePending: false,
      }
      set({ lastResult: result })
      return result
    }

    const db = getLiveDatabase()
    if (!db) {
      const result: QueryExecutionResult = {
        success: false,
        query: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: performance.now() - startedAt,
        statementType: 'UNKNOWN' as StatementType,
        statements: [],
        databaseId,
        error: 'No database is open. Create or open one from the database selector.',
        committed: false,
        rolledBack: false,
        persistencePending: false,
      }
      set({ lastResult: result })
      return result
    }

    set({ isExecuting: true })
    try {
      const statements = db.executeBatch(sql)
      const executionTime = performance.now() - startedAt

      const primary =
        statements.find((statement) => statement.hasResultSet) ??
        statements[statements.length - 1] ??
        null

      const result: QueryExecutionResult = {
        success: true,
        query: sql,
        columns: primary?.columns ?? [],
        rows: primary?.rows ?? [],
        rowCount: primary?.rowCount ?? 0,
        executionTime,
        statementType: statements[0]?.statementType ?? 'UNKNOWN',
        statements,
        databaseId,
        committed: true,
        rolledBack: false,
        persistencePending: false,
      }

      // Persist schema-affecting/data changes and refresh the explorer.
      const mutating = statements.some((statement) =>
        isMutatingStatementType(statement.statementType),
      )
      if (mutating) {
        let persistenceError: string | null = null
        try {
          const persisted = await persistActiveDatabase(db)
          if (!persisted) persistenceError = 'The database snapshot could not be saved.'
        } catch (error) {
          persistenceError = messageOf(error, 'The database snapshot could not be saved.')
        }

        // Refresh committed schema even when durable persistence fails.
        if (getLiveDatabase() === db) {
          get().refreshSchema()
          set({ databases: [...getDatabases()] })
        }

        if (persistenceError !== null) {
          const pending: QueryExecutionResult = {
            ...result,
            success: false,
            committed: true,
            rolledBack: false,
            persistencePending: true,
            persistenceError,
            error: `SQLite committed, but persistence failed: ${persistenceError} The committed changes remain in memory and can be saved by retrying persistence.`,
          }
          if (getLiveDatabase() === db) {
            set({ isExecuting: false, lastResult: pending })
          } else {
            set({ isExecuting: false })
          }
          return pending
        }
      }

      // A database switch during execution must not surface this result
      // in the new database's workspace.
      if (getLiveDatabase() === db) {
        set({ isExecuting: false, lastResult: result })
      } else {
        set({ isExecuting: false })
      }
      return result
    } catch (error) {
      const executionTime = performance.now() - startedAt
      const sqliteError = error instanceof SqlExecutionError ? error : null
      const message = sqliteError
        ? sqliteError.message
        : error instanceof Error
          ? error.message
          : String(error)

      const rolledBack = sqliteError?.rolledBack === true
      const result: QueryExecutionResult = {
        success: false,
        query: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime,
        statementType: 'UNKNOWN' as StatementType,
        statements: [],
        databaseId,
        error: sqliteError?.rollbackError ?? (rolledBack ? `Batch rolled back: ${message}` : message),
        errorStatementIndex: sqliteError?.statementIndex,
        committed: false,
        rolledBack,
        persistencePending: false,
      }
      if (getLiveDatabase() === db) {
        set({ isExecuting: false, lastResult: result })
      } else {
        set({ isExecuting: false })
      }
      return result
    }
  },

  refreshSchema: () => {
    const db = getLiveDatabase()
    if (!db) {
      set({ schema: null })
      return
    }
    const info = getActiveDatabase()
    set({ schema: getDatabaseSchema(db, info?.name ?? 'Database') })
  },

  openDatabase: async (id) => {
    const schema = await openManagedDatabase(id)
    applyActiveDatabase(set, schema, id)
  },

  createDatabase: async (input) => {
    const { info, schema } = await createManagedDatabase(input)
    applyActiveDatabase(set, schema, info.id)
    return info
  },

  importDatabase: async (input) => {
    const { info, schema } = await importManagedDatabase(input)
    applyActiveDatabase(set, schema, info.id)
    return info
  },

  renameDatabase: async (id, name) => {
    const info = await renameManagedDatabase(id, name)
    set({ databases: [...getDatabases()] })
    if (get().activeDatabaseId === id) {
      get().refreshSchema()
    }
    return info
  },

  duplicateDatabase: async (id, name) => {
    const info = await duplicateManagedDatabase(id, name)
    set({ databases: [...getDatabases()] })
    return info
  },

  deleteDatabase: async (id) => {
    const result = await deleteManagedDatabase(id)
    applyActiveDatabase(set, result.schema, result.activeDatabaseId)
  },

  resetDatabase: async (id, config) => {
    const targetId = id ?? getActiveDatabaseId()
    const schema = await resetManagedDatabase(id, config)
    const activeId = getActiveDatabaseId()
    const isActive = targetId === activeId
    set({
      ...(isActive ? { schema, lastResult: null } : {}),
      activeDatabaseId: activeId,
      databases: [...getDatabases()],
    })
    // Resetting another database must not clear the active canvas/results.
    if (isActive) resetVisualizationForDatabaseSwitch()
    return schema
  },

  exportDatabase: async (id) => exportManagedDatabase(id),

  exportDatabaseSql: async (id) => exportManagedDatabaseSql(id),
}))
