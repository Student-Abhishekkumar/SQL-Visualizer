import type { SQLiteDatabase } from '../database/sqliteService'
import { quoteIdentifier } from '../database/schemaService'
import { deriveAffinity } from './sqliteAffinity'
import type {
  DdlCatalogObject,
  DdlIndexState,
  DdlSchemaState,
  DdlTableState,
} from '../../types/visualization'

/** Read the real SQLite catalog, including automatic constraint indexes. */
export function readDdlCatalog(db: SQLiteDatabase): DdlCatalogObject[] {
  return db.queryAll(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
     WHERE type IN ('table', 'index', 'view', 'trigger')
     ORDER BY type, name`,
  ).values.map((row) => ({
    type: String(row[0]) as DdlCatalogObject['type'],
    name: String(row[1]),
    tableName: String(row[2] ?? ''),
    sql: row[3] == null ? null : String(row[3]),
  }))
}

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function readTableIndexes(
  db: SQLiteDatabase,
  tableName: string,
  catalog: DdlCatalogObject[],
): DdlIndexState[] {
  return db.queryAll(`PRAGMA index_list(${quoteIdentifier(tableName)})`).values.map((row) => {
    const name = String(row[1])
    const keyRows = db.queryAll(`PRAGMA index_xinfo(${quoteIdentifier(name)})`).values
      .filter((keyRow) => Number(keyRow[5] ?? 1) === 1)
      .sort((left, right) => Number(left[0]) - Number(right[0]))
    const origin = String(row[3] ?? 'c')
    return {
      name,
      tableName,
      unique: Number(row[2]) === 1,
      origin: origin === 'pk' ? 'primary-key' : origin === 'u' ? 'unique' : 'created',
      columns: keyRows.map((keyRow) => keyRow[2] == null ? null : String(keyRow[2])),
      sql: catalog.find((object) => object.type === 'index' && sameName(object.name, name))?.sql ?? null,
    }
  })
}

/** Capture one table entirely from PRAGMA and SQLite row reads. */
export function readDdlTable(
  db: SQLiteDatabase,
  tableName: string,
  catalog = readDdlCatalog(db),
): DdlTableState | null {
  const object = catalog.find((candidate) => candidate.type === 'table' && sameName(candidate.name, tableName))
  if (object === undefined) return null
  const actualName = object.name
  const safeName = quoteIdentifier(actualName)
  // table_xinfo includes generated columns, which are also in SELECT *.
  const columnRows = db.queryAll(`PRAGMA table_xinfo(${safeName})`).values
    .filter((row) => Number(row[6] ?? 0) !== 1)
  const foreignKeyRows = db.queryAll(`PRAGMA foreign_key_list(${safeName})`).values
  const indexes = readTableIndexes(db, actualName, catalog)
  const primaryKeyCount = columnRows.filter((row) => Number(row[5]) > 0).length
  const uniqueColumns = new Set(
    indexes
      .filter((index) => index.unique && index.columns.length === 1 && index.columns[0] !== null)
      .map((index) => String(index.columns[0]).toLowerCase()),
  )
  const columns = columnRows.map((row) => {
    const name = String(row[1])
    const primaryKeyPosition = Number(row[5])
    return {
      name,
      declaredType: String(row[2] ?? ''),
      affinity: deriveAffinity(String(row[2] ?? '')),
      notNull: Number(row[3]) === 1,
      primaryKeyPosition,
      defaultSql: row[4] == null ? null : String(row[4]),
      unique: uniqueColumns.has(name.toLowerCase()) || (primaryKeyCount === 1 && primaryKeyPosition > 0),
      foreignKeys: foreignKeyRows
        .filter((foreignKey) => sameName(String(foreignKey[3] ?? ''), name))
        .map((foreignKey) => ({
          targetTable: String(foreignKey[2]),
          targetColumn: foreignKey[4] == null ? null : String(foreignKey[4]),
          onUpdate: String(foreignKey[5]),
          onDelete: String(foreignKey[6]),
        })),
    }
  })
  const rows = db.queryAll(`SELECT * FROM ${safeName}`).values.map((row) => [...row])
  return { name: actualName, sql: object.sql, columns, indexes, rowCount: rows.length, rows }
}

/** Resolve an object and its owning table without assuming name casing. */
export function captureDdlSchema(
  db: SQLiteDatabase,
  objectType: 'TABLE' | 'INDEX',
  objectName: string,
  targetTable?: string,
): DdlSchemaState {
  const catalog = readDdlCatalog(db)
  const type = objectType.toLowerCase() as DdlCatalogObject['type']
  const object = catalog.find((candidate) => candidate.type === type && sameName(candidate.name, objectName))
  const tableName = objectType === 'TABLE' ? object?.name : (object?.tableName ?? targetTable)
  const table = tableName === undefined ? null : readDdlTable(db, tableName, catalog)
  const index = objectType === 'INDEX' && table !== null
    ? table.indexes.find((candidate) => sameName(candidate.name, objectName)) ?? null
    : null
  return { catalog, table, index }
}
