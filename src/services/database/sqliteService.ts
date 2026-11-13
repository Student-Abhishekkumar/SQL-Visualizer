import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import type { StatementResult } from '../../types/query'
import { detectStatementType, isMutatingStatementType } from '../sql/sqlParser'
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

  constructor(message: string, statementIndex: number) {
    super(message)
    this.name = 'SqlExecutionError'
    this.statementIndex = statementIndex
  }
}

let sqlJsSingleton: Promise<SqlJsStatic> | null = null

/**
 * Load (and memoize) the SQLite WASM runtime. `config` is only used on
 * the first call; the browser entry point passes a locateFile hook
 * pointing at the bundled sql-wasm.wasm asset.
 */
export function loadSqlJs(config?: Parameters<typeof initSqlJs>[0]): Promise<SqlJsStatic> {
  if (!sqlJsSingleton) {
    sqlJsSingleton = initSqlJs(config)
  }
  return sqlJsSingleton
}

/** Test/worker hosts may need to reset the memoized runtime. */
export function disposeSqlJsRuntime(): void {
  sqlJsSingleton = null
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
    const raw = snapshot ? new SQL.Database(snapshot) : new SQL.Database()
    // Foreign key enforcement is a per-connection pragma in SQLite.
    raw.run('PRAGMA foreign_keys = ON;')
    return new SQLiteDatabase(raw)
  }

  /**
   * Execute a batch of statements separated by semicolons.
   * Statements run sequentially and stop at the first error; results
   * for statements that already succeeded are still returned.
   */
  executeBatch(sql: string): StatementResult[] {
    const statements = splitStatements(sql)
    const results: StatementResult[] = []

    for (let index = 0; index < statements.length; index++) {
      const statement = statements[index] as string
      const startedAt = performance.now()
      try {
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
        const type = detectStatementType(statement)

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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new SqlExecutionError(message, index)
      }
    }

    return results
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
    const result = this.db.exec(sql)
    const primary = result[0]
    return {
      columns: primary?.columns ?? [],
      values: primary?.values ?? [],
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
