import type { VisualizationTrace } from './visualization'

/** Schema information for a single column. */
export interface ColumnSchema {
  name: string
  /** Declared SQLite type affinity, e.g. INTEGER, TEXT. */
  type: string
  notNull: boolean
  isPrimaryKey: boolean
  isForeignKey: boolean
  /** Present only when isForeignKey is true. */
  foreignKey?: ForeignKeyReference
}

/** Where a foreign key column points to. */
export interface ForeignKeyReference {
  table: string
  column: string
}

/** An index (or unique constraint) discovered through SQLite pragmas. */
export interface IndexSchema {
  name: string
  unique: boolean
  /** `pk`, `unique` (constraint-backed) or `created` (explicit index). */
  origin: 'pk' | 'unique' | 'created'
  columns: string[]
}

/** Schema information for a table. */
export interface TableSchema {
  name: string
  columns: ColumnSchema[]
  /** Live row count at the time the schema was read. */
  rowCount: number
  /** Indexes and unique constraints declared on the table. */
  indexes: IndexSchema[]
  /** Original CREATE TABLE statement from sqlite_master, when available. */
  sql?: string
}

/** Full schema snapshot of the working database. */
export interface DatabaseSchema {
  name: string
  tables: TableSchema[]
  /** Views discovered in sqlite_master. */
  views: string[]
  /** Triggers discovered in sqlite_master. */
  triggers: string[]
}

/** Lifecycle status of the SQLite WASM database. */
export type DatabaseStatus =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'error'

/**
 * How a database was created. Templates are optional starting points;
 * creating one never seeds data unless the user picked the example.
 */
export type DatabaseTemplateId = 'blank' | 'example' | 'custom' | 'imported'

/**
 * Persisted metadata for one independent SQLite database.
 * `tableCount`/`rowCount` are cached stats refreshed whenever the
 * database is opened or modified; they are not the source of truth.
 */
export interface DatabaseInfo {
  id: string
  name: string
  description: string
  template: DatabaseTemplateId
  createdAt: number
  updatedAt: number
  tableCount: number
  rowCount: number
  sizeBytes: number
  /** Setup SQL replayed on reset for custom-template databases. */
  setupSql?: string
}

export type { VisualizationTrace }
