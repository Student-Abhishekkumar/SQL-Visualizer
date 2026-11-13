import { create } from 'zustand'
import type { DatabaseSchema, DatabaseStatus } from '../types/database'
import type { QueryExecutionResult, StatementType } from '../types/query'
import {
  getLiveDatabase,
  initializeDatabase,
  persistDatabase,
  resetDatabase,
  type SqlJsConfig,
} from '../services/database/databaseInitializer'
import { getDatabaseSchema } from '../services/database/schemaService'
import { SqlExecutionError, hasExecutableSql } from '../services/database/sqliteService'
import {
  isMutatingStatementType,
} from '../services/sql/sqlParser'

/**
 * Database application state: lifecycle, live schema snapshot and the
 * last execution result. Execution itself always goes through
 * `execute()` so history, persistence and schema refresh stay in sync.
 */

interface DatabaseState {
  status: DatabaseStatus
  /** Populated when status === 'error'. */
  initError: string | null
  schema: DatabaseSchema | null
  isExecuting: boolean
  lastResult: QueryExecutionResult | null

  initialize: (config?: SqlJsConfig) => Promise<void>
  execute: (sql: string) => Promise<QueryExecutionResult>
  reset: (config?: SqlJsConfig) => Promise<DatabaseSchema | null>
  refreshSchema: () => void
}

let schemaName = 'Database'

export const useDatabaseStore = create<DatabaseState>()((set, get) => ({
  status: 'uninitialized',
  initError: null,
  schema: null,
  isExecuting: false,
  lastResult: null,

  initialize: async (config) => {
    if (get().status === 'initializing') return
    set({ status: 'initializing', initError: null })
    try {
      const result = await initializeDatabase(config)
      schemaName = result.schema.name
      set({
        status: 'ready',
        schema: result.schema,
        initError: null,
      })
    } catch (error) {
      set({
        status: 'error',
        initError:
          error instanceof Error ? error.message : 'Failed to initialize database',
      })
    }
  },

  execute: async (sql) => {
    const startedAt = performance.now()

    if (!hasExecutableSql(sql)) {
      return {
        success: false,
        query: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: performance.now() - startedAt,
        statementType: 'UNKNOWN' as StatementType,
        statements: [],
        error: 'No SQL statement to execute. Write a query or pick an example first.',
      }
    }

    const db = getLiveDatabase()
    if (!db) {
      return {
        success: false,
        query: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime: performance.now() - startedAt,
        statementType: 'UNKNOWN' as StatementType,
        statements: [],
        error: 'Database is not ready yet. Please try again in a moment.',
      }
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
      }

      // Persist schema-affecting/data changes and refresh the explorer.
      const mutating = statements.some((statement) =>
        isMutatingStatementType(statement.statementType),
      )
      if (mutating) {
        await persistDatabase(db)
        get().refreshSchema()
      }

      set({ isExecuting: false, lastResult: result })
      return result
    } catch (error) {
      const executionTime = performance.now() - startedAt
      const sqliteError =
        error instanceof SqlExecutionError
          ? error
          : null
      const message = sqliteError
        ? sqliteError.message
        : error instanceof Error
          ? error.message
          : String(error)

      const result: QueryExecutionResult = {
        success: false,
        query: sql,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTime,
        statementType: 'UNKNOWN' as StatementType,
        statements: [],
        error: message,
        errorStatementIndex: sqliteError?.statementIndex,
      }
      set({ isExecuting: false, lastResult: result })
      return result
    }
  },

  reset: async (config) => {
    try {
      const schema = await resetDatabase(config)
      schemaName = schema.name
      set({
        status: 'ready',
        schema,
        initError: null,
        lastResult: null,
      })
      return schema
    } catch (error) {
      set({
        status: 'error',
        initError:
          error instanceof Error ? error.message : 'Failed to reset database',
      })
      return null
    }
  },

  refreshSchema: () => {
    const db = getLiveDatabase()
    if (!db) return
    set({ schema: getDatabaseSchema(db, schemaName) })
  },
}))
