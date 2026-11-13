import type {
  ColumnSchema,
  DatabaseSchema,
  TableSchema,
} from '../../types/database'
import type { SQLiteDatabase } from './sqliteService'

/**
 * Schema introspection for the database explorer.
 * All information comes from live SQLite pragmas and catalog queries —
 * nothing is hardcoded.
 */

/** User tables (system tables excluded), sorted alphabetically. */
export function getDatabaseSchema(db: SQLiteDatabase, dbName: string): DatabaseSchema {
  const { values: tableRows } = db.queryAll(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )

  const tables: TableSchema[] = []
  for (const row of tableRows) {
    const tableName = String(row[0])
    tables.push(getTableSchema(db, tableName))
  }

  return { name: dbName, tables }
}

/** Columns (with PK/FK flags) and live row count for one table. */
export function getTableSchema(db: SQLiteDatabase, tableName: string): TableSchema {
  const safeName = quoteIdentifier(tableName)

  // PRAGMA table_info: [cid, name, type, notnull, dflt_value, pk]
  const { values: columnRows } = db.queryAll(`PRAGMA table_info(${safeName})`)
  // PRAGMA foreign_key_list: [id, seq, table, from, to, on_update, on_delete, match]
  const { values: fkRows } = db.queryAll(`PRAGMA foreign_key_list(${safeName})`)

  const foreignKeyByColumn = new Map<string, { table: string; column: string }>()
  for (const row of fkRows) {
    const from = String(row[3] ?? '')
    const toTable = String(row[2] ?? '')
    const toColumn = row[4] == null ? '' : String(row[4])
    // A column can participate in a composite FK; first mapping wins.
    if (!foreignKeyByColumn.has(from)) {
      foreignKeyByColumn.set(from, { table: toTable, column: toColumn })
    }
  }

  const columns: ColumnSchema[] = columnRows.map((row) => {
    const name = String(row[1])
    const fk = foreignKeyByColumn.get(name)
    const column: ColumnSchema = {
      name,
      type: String(row[2] ?? '') || 'ANY',
      notNull: Number(row[3]) === 1,
      isPrimaryKey: Number(row[5]) > 0,
      isForeignKey: fk !== undefined,
    }
    if (fk) column.foreignKey = fk
    return column
  })

  let rowCount = 0
  try {
    const count = db.queryOne(`SELECT COUNT(*) FROM ${safeName}`)
    rowCount = Number(count?.row[0] ?? 0)
  } catch {
    rowCount = 0
  }

  return { name: tableName, columns, rowCount }
}

/** Double-quoted identifier with embedded quotes escaped. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}
