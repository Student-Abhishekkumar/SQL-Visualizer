/**
 * Core query execution types shared between the database engine,
 * the UI and (in Stage 2) the visualization engine.
 */

import type { VisualizationTrace } from './visualization'

/** Coarse-grained classification of a single SQL statement. */
export type StatementType =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE'
  | 'CREATE'
  | 'DROP'
  | 'ALTER'
  | 'REPLACE'
  | 'PRAGMA'
  | 'BEGIN'
  | 'COMMIT'
  | 'ROLLBACK'
  | 'VACUUM'
  | 'ANALYZE'
  | 'EXPLAIN'
  | 'UNKNOWN'

/**
 * Result of executing exactly one SQL statement.
 * `columns`/`values` preserve duplicate column names from joins;
 * `rows` provides convenient record access (later duplicate keys win).
 */
export interface StatementResult {
  /** The SQL text of this individual statement. */
  statement: string
  statementType: StatementType
  /** Column names as returned by SQLite. */
  columns: string[]
  /** Rows as record objects — convenience for consumers. */
  rows: Record<string, unknown>[]
  /** Raw positional values, aligned with `columns` (duplicate-safe). */
  values: unknown[][]
  /** Number of rows in the result set (0 for non-SELECT). */
  rowCount: number
  /** Rows modified by INSERT/UPDATE/DELETE, or null when not applicable. */
  rowsModified: number | null
  /** Whether this statement produced a result set. */
  hasResultSet: boolean
  /** Execution duration in milliseconds (performance.now based). */
  executionTime: number
}

/**
 * Normalized result of executing the editor's full content, which may
 * contain multiple statements. The flat fields mirror the primary
 * (first result-producing) statement so simple consumers can treat the
 * result like a single result set.
 */
export interface QueryExecutionResult {
  success: boolean
  /** The original, unmodified query text. */
  query: string
  /** Result columns of the primary statement ('' when none). */
  columns: string[]
  /** Result rows of the primary statement ([] when none). */
  rows: Record<string, unknown>[]
  rowCount: number
  /** Total wall-clock duration of the whole execution, in ms. */
  executionTime: number
  /** Type of the first meaningful statement. */
  statementType: StatementType
  /** Per-statement breakdown, in execution order. */
  statements: StatementResult[]
  /** User-friendly error message when success is false. */
  error?: string
  /** Index into `statements`/source statements when execution aborted. */
  errorStatementIndex?: number
  /** Database the query actually ran against (set by the store). */
  databaseId?: string
  /**
   * Stage 2 hook: the visualization engine will attach an execution
   * trace here. Stage 1 never populates it.
   */
  visualization?: VisualizationTrace | null
}

/** A single entry in the query history list (results are not stored). */
export interface HistoryEntry {
  id: string
  sql: string
  timestamp: number
  success: boolean
  executionTime: number
  rowCount: number
  statementType: StatementType
  /** Database the query was executed against (v2 workspace). */
  databaseId?: string
}

/** A user-saved, named query. */
export interface SavedQuery {
  id: string
  name: string
  sql: string
  createdAt: number
  /** Database the query was written for; absent means "any database". */
  databaseId?: string
}
