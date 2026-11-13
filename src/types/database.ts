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

/** Schema information for a table. */
export interface TableSchema {
  name: string
  columns: ColumnSchema[]
  /** Live row count at the time the schema was read. */
  rowCount: number
}

/** Full schema snapshot of the working database. */
export interface DatabaseSchema {
  name: string
  tables: TableSchema[]
}

/** Lifecycle status of the SQLite WASM database. */
export type DatabaseStatus =
  | 'uninitialized'
  | 'initializing'
  | 'ready'
  | 'error'

export type { VisualizationTrace }
