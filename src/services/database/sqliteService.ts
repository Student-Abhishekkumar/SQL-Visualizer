import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import type { StatementResult } from '../../types/query'
import { classifyStatementType, isMutatingStatementType } from '../sql/statementTypes'
import { hasExecutableContent, splitStatements } from '../../utils/queryHelpers'

/**
 * Core SQLite execution engine.
 *
 * Wraps sql.js (SQLite compiled to WebAssembly) behind a small, typed
 * API: statement execution with per-statement metadata, snapshot
 * export for persistence, and schema introspection helpers.
 *
 * The engine is UI-agnostic so Stage 2 can reuse it (or swap in a Web
 * Worker host) without touching application state.
 */

/** Error raised for SQLite-level failures with a user-friendly message. */
export class SqlExecutionError extends Error {
  /** 0-based index of the offending statement in the submitted batch. */
  readonly statementIndex: number
  /** True when the application-managed transaction was rolled back. */
  readonly rolledBack: boolean
  /** Present when rollback itself failed and needs operator attention. */
  readonly rollbackError?: string

  constructor(
    message: string,
    statementIndex: number,
    rolledBack = false,
    rollbackError?: string,
  ) {
    super(message)
    this.name = 'SqlExecutionError'
    this.statementIndex = statementIndex
    this.rolledBack = rolledBack
    this.rollbackError = rollbackError
  }
}

/** Reject user transaction control before an application transaction starts. */
function isTransactionControlStatement(sql: string): boolean {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
  return /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)(?:\s|$)/i.test(stripped)
}

let sqlJsSingleton: Promise<SqlJsStatic> | null = null
/** Resolved runtime, retained so snapshot clones can be created synchronously. */
let sqlJsRuntime: SqlJsStatic | null = null

/**
 * Load (and memoize) the SQLite WASM runtime. `config` is only used on
 * the first call; the browser entry point passes a locateFile hook
 * pointing at the bundled sql-wasm.wasm asset.
 */
export function loadSqlJs(config?: Parameters<typeof initSqlJs>[0]): Promise<SqlJsStatic> {
  if (sqlJsSingleton !== null) return sqlJsSingleton

  let attempt: Promise<SqlJsStatic>
  try {
    attempt = initSqlJs(config)
  } catch (error) {
    sqlJsSingleton = null
    throw error
  }

  sqlJsSingleton = attempt
  // Cache only the in-flight/successful attempt. A rejection clears itself,
  // but must never clear a newer attempt installed after an explicit reset.
  void attempt.then(
    (runtime) => {
      if (sqlJsSingleton === attempt) sqlJsRuntime = runtime
    },
    () => {
      if (sqlJsSingleton === attempt) sqlJsSingleton = null
    },
  )
  return attempt
}

/** Test/worker hosts may need to reset the memoized runtime. */
export function disposeSqlJsRuntime(): void {
  sqlJsSingleton = null
  sqlJsRuntime = null
}

export class SQLiteDatabase {
  private readonly db: Database

  private constructor(db: Database) {
    this.db = db
  }

  /** Create a database, optionally restoring a previously exported snapshot. */
  static async create(
    config?: Parameters<typeof loadSqlJs>[0],
    snapshot?: Uint8Array,
  ): Promise<SQLiteDatabase> {
    const SQL = await loadSqlJs(config)
    sqlJsRuntime = SQL
    const raw = snapshot ? new SQL.Database(snapshot) : new SQL.Database()
    // Foreign key enforcement is a per-connection pragma in SQLite.
    raw.run('PRAGMA foreign_keys = ON;')
    return new SQLiteDatabase(raw)
  }

  /**
   * Create an independent, unpersisted database from serialized bytes.
   * The active database implies that the shared sql.js runtime is loaded,
   * so visualization can clone synchronously without touching its connection.
   */
  static createFromSnapshot(bytes: Uint8Array): SQLiteDatabase {
    if (sqlJsRuntime === null) {
      throw new Error('SQLite must be initialized before cloning a database snapshot.')
    }
    // Copy the bytes: sql.js may retain the buffer, and the active database
    // must never share storage with a preview connection.
    const raw = new sqlJsRuntime.Database(new Uint8Array(bytes))
    raw.run('PRAGMA foreign_keys = ON;')
    return new SQLiteDatabase(raw)
  }

  /**
   * Execute a batch of statements separated by semicolons.
   * Multi-statement batches are atomic: an application transaction commits
   * only after every statement succeeds and rolls back on any failure.
   * Transaction-control statements are rejected before execution so user
   * SQL cannot bypass that guarantee or create nested transactions.
   */
  executeBatch(sql: string): StatementResult[] {
    const statements = splitStatements(sql)
    const results: StatementResult[] = []
    if (statements.length === 0) return results

    for (let index = 0; index < statements.length; index++) {
      if (isTransactionControlStatement(statements[index] as string)) {
        throw new SqlExecutionError(
          'Transaction-control statements are not supported in application-managed batches. Remove BEGIN, COMMIT, ROLLBACK, SAVEPOINT, RELEASE, and END statements.',
          index,
          false,
        )
      }
    }

    const transactional = statements.length > 1
    let transactionStarted = false
    let index = 0
    try {
      if (transactional) {
        this.db.run('BEGIN TRANSACTION')
        transactionStarted = true
      }

      for (index = 0; index < statements.length; index++) {
        const statement = statements[index] as string
        const startedAt = performance.now()
        // prepare/step instead of exec() so zero-row queries still
        // expose their column names (exec() omits empty result sets).
        const stmt = this.db.prepare(statement)
        const columns = stmt.getColumnNames()
        const values: unknown[][] = []
        try {
          while (stmt.step()) {
            values.push(stmt.get() as unknown[])
          }
        } finally {
          stmt.free()
        }
        const executionTime = performance.now() - startedAt
        const type = classifyStatementType(statement)

        const rows = values.map((row) => {
          const record: Record<string, unknown> = {}
          columns.forEach((column, columnIndex) => {
            record[column] = row[columnIndex] ?? null
          })
          return record
        })

        results.push({
          statement,
          statementType: type,
          columns,
          rows,
          values,
          rowCount: values.length,
          rowsModified: isMutatingStatementType(type)
            ? this.db.getRowsModified()
            : null,
          hasResultSet: columns.length > 0,
          executionTime,
        })
      }

      if (transactional) {
        this.db.run('COMMIT')
        transactionStarted = false
      }
      return results
    } catch (error) {
      let rolledBack = false
      let rollbackError: string | undefined
      if (transactionStarted) {
        try {
          this.db.run('ROLLBACK')
          rolledBack = true
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure instanceof Error
            ? rollbackFailure.message
            : String(rollbackFailure)
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      const failureIndex = Math.min(index, statements.length - 1)
      throw new SqlExecutionError(message, failureIndex, rolledBack, rollbackError)
    }
  }

  // ------------------------------------------------------------------
  // Internal helpers used by the schema service. These bypass batch
  // processing and are not part of the public playground flow.
  // ------------------------------------------------------------------

  /** Run a DDL/DML string without returning rows (throws on error). */
  runRaw(sql: string): void {
    this.db.run(sql)
  }

  /** Execute a single query and return positional rows. */
  queryAll(sql: string): { columns: string[]; values: unknown[][] } {
    // prepare/step instead of exec() so zero-row queries still expose their
    // column names. exec() omits an empty result set entirely, which would
    // make an empty table look like a table without columns.
    const stmt = this.db.prepare(sql)
    try {
      const columns = stmt.getColumnNames()
      const values: unknown[][] = []
      while (stmt.step()) values.push(stmt.get() as unknown[])
      return { columns, values }
    } finally {
      stmt.free()
    }
  }

  /** Execute a single-row query; null when there is no row. */
  queryOne(sql: string): { columns: string[]; row: unknown[] } | null {
    const { columns, values } = this.queryAll(sql)
    const row = values[0]
    return row ? { columns, row } : null
  }

  /** Current SQLite library version, e.g. "3.45.0". */
  sqliteVersion(): string {
    const result = this.queryOne('SELECT sqlite_version() AS version')
    return String(result?.row[0] ?? 'unknown')
  }

  /** Serialize the full database to bytes for persistence. */
  exportSnapshot(): Uint8Array {
    return this.db.export()
  }

  close(): void {
    this.db.close()
  }
}

/** True when a raw SQL string contains at least one executable statement. */
export function hasExecutableSql(sql: string): boolean {
  return splitStatements(sql).some(hasExecutableContent)
}
