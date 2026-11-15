import type {
  ColumnSchema,
  DatabaseSchema,
  IndexSchema,
  TableSchema,
} from '../../types/database'
import type { SQLiteDatabase } from './sqliteService'

/**
 * Schema introspection for the database explorer.
 * All information comes from live SQLite pragmas and catalog queries —
 * nothing is hardcoded, so any user-created table is discovered.
 */

interface TableRow {
  name: string
  sql: string | null
}

/** User tables (system tables excluded), sorted alphabetically. */
export function getDatabaseSchema(db: SQLiteDatabase, dbName: string): DatabaseSchema {
  const { values: tableRows } = db.queryAll(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )

  const tables: TableSchema[] = []
  for (const row of tableRows) {
    const table: TableRow = {
      name: String(row[0]),
      sql: row[1] == null ? null : String(row[1]),
    }
    tables.push(getTableSchema(db, table.name, table.sql))
  }

  const { values: viewRows } = db.queryAll(
    `SELECT name FROM sqlite_master
     WHERE type = 'view' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )
  const { values: triggerRows } = db.queryAll(
    `SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )

  return {
    name: dbName,
    tables,
    views: viewRows.map((row) => String(row[0])),
    triggers: triggerRows.map((row) => String(row[0])),
  }
}

/** Columns, indexes (with PK/FK flags) and live row count for one table. */
export function getTableSchema(
  db: SQLiteDatabase,
  tableName: string,
  createSql?: string | null,
): TableSchema {
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

  const sql =
    createSql === undefined
      ? (db.queryOne(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${quoteLiteral(tableName)}`,
        )?.row[0] as string | null | undefined) ?? null
      : createSql

  const table: TableSchema = {
    name: tableName,
    columns,
    rowCount,
    indexes: getTableIndexes(db, tableName),
  }
  if (sql != null) table.sql = sql
  return table
}

/** Indexes and unique constraints for a table (PRAGMA index_list). */
export function getTableIndexes(db: SQLiteDatabase, tableName: string): IndexSchema[] {
  const safeName = quoteIdentifier(tableName)
  // PRAGMA index_list: [seq, name, unique, origin, partial]
  const { values: indexRows } = db.queryAll(`PRAGMA index_list(${safeName})`)

  const indexes: IndexSchema[] = []
  for (const row of indexRows) {
    const indexName = String(row[1] ?? '')
    if (indexName === '') continue
    const originRaw = String(row[3] ?? 'c')
    const origin: IndexSchema['origin'] =
      originRaw === 'pk' ? 'pk' : originRaw === 'u' ? 'unique' : 'created'

    // PRAGMA index_info: [seqno, cid, name]
    const { values: columnRows } = db.queryAll(
      `PRAGMA index_info(${quoteIdentifier(indexName)})`,
    )
    const columns = columnRows
      .map((columnRow) => (columnRow[2] == null ? '' : String(columnRow[2])))
      .filter((column) => column !== '')

    indexes.push({
      name: indexName,
      unique: Number(row[2]) === 1,
      origin,
      columns,
    })
  }
  return indexes
}

/** Aggregate table/row stats used by database metadata. */
export function getSchemaStats(schema: DatabaseSchema): {
  tableCount: number
  rowCount: number
} {
  return {
    tableCount: schema.tables.length,
    rowCount: schema.tables.reduce((total, table) => total + table.rowCount, 0),
  }
}

/** Double-quoted identifier with embedded quotes escaped. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

/** Single-quoted SQL literal with embedded quotes escaped. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
