import type { DatabaseSchema } from '../../types/database'
import { quoteIdentifier, quoteLiteral } from './schemaService'
import type { SQLiteDatabase } from './sqliteService'

/** Explicit export failure; callers must not download a partial SQL dump. */
export class SqlDumpError extends Error {
  readonly tableName: string

  constructor(tableName: string, cause: unknown) {
    super(
      `Could not read table "${tableName}" while exporting. The SQL dump was not generated.`,
      { cause },
    )
    this.name = 'SqlDumpError'
    this.tableName = tableName
  }
}

/**
 * Human-readable SQL dump generation.
 *
 * This intentionally produces a *script* (`CREATE TABLE`, `INSERT`, then
 * indexes/views/triggers) — never labelled as a native SQLite database
 * file. The binary `.sqlite` export lives in the database manager.
 */
export function buildSqlDump(
  db: SQLiteDatabase,
  schema: DatabaseSchema,
  options: { databaseName?: string } = {},
): string {
  const lines: string[] = []
  lines.push('-- SQL Visualizer database export')
  if (options.databaseName) {
    lines.push(`-- Database: ${options.databaseName}`)
  }
  lines.push(`-- Generated: ${new Date().toISOString()}`)
  lines.push('-- This is a SQL script, not a binary SQLite database file.')
  lines.push('')
  lines.push('PRAGMA foreign_keys = OFF;')
  lines.push('BEGIN TRANSACTION;')
  lines.push('')

  for (const table of schema.tables) {
    const create =
      table.sql ??
      buildCreateTableFallback(table.name, table.columns)
    lines.push(`-- Table: ${table.name}`)
    lines.push(`${normalizeStatement(create)};`)
    lines.push('')
  }

  for (const table of schema.tables) {
    const safeName = quoteIdentifier(table.name)
    let rows: { columns: string[]; values: unknown[][] }
    try {
      rows = db.queryAll(`SELECT * FROM ${safeName}`)
    } catch (error) {
      throw new SqlDumpError(table.name, error)
    }
    if (rows.values.length === 0) continue

    const columnList = rows.columns.map(quoteIdentifier).join(', ')
    lines.push(`-- Data: ${table.name}`)
    for (const row of rows.values) {
      const values = row.map(formatSqlValue).join(', ')
      lines.push(`INSERT INTO ${safeName} (${columnList}) VALUES (${values});`)
    }
    lines.push('')
  }

  // Indexes (explicit only — auto-created index SQL is null).
  const indexes = db.queryAll(
    `SELECT sql FROM sqlite_master
     WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )
  if (indexes.values.length > 0) {
    lines.push('-- Indexes')
    for (const row of indexes.values) {
      const sql = String(row[0] ?? '').trim()
      if (sql) lines.push(`${normalizeStatement(sql)};`)
    }
    lines.push('')
  }

  const views = db.queryAll(
    `SELECT sql FROM sqlite_master
     WHERE type = 'view' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )
  if (views.values.length > 0) {
    lines.push('-- Views')
    for (const row of views.values) {
      const sql = String(row[0] ?? '').trim()
      if (sql) lines.push(`${normalizeStatement(sql)};`)
    }
    lines.push('')
  }

  const triggers = db.queryAll(
    `SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )
  if (triggers.values.length > 0) {
    lines.push('-- Triggers')
    for (const row of triggers.values) {
      const sql = String(row[0] ?? '').trim()
      if (sql) lines.push(`${normalizeStatement(sql)};`)
    }
    lines.push('')
  }

  lines.push('COMMIT;')
  lines.push('PRAGMA foreign_keys = ON;')
  lines.push('')
  return lines.join('\n')
}

/** Format one SQLite value as a SQL literal. */
export function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NULL'
    return Number.isFinite(value) ? String(value) : 'NULL'
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) {
    return `X'${bytesToHex(value)}'`
  }
  if (typeof value === 'string') return quoteLiteral(value)
  return quoteLiteral(String(value))
}

function buildCreateTableFallback(
  tableName: string,
  columns: DatabaseSchema['tables'][number]['columns'],
): string {
  const definitions = columns.map((column) => {
    const parts = [quoteIdentifier(column.name), column.type || 'ANY']
    if (column.isPrimaryKey) parts.push('PRIMARY KEY')
    if (column.notNull) parts.push('NOT NULL')
    return parts.join(' ')
  })
  return `CREATE TABLE ${quoteIdentifier(tableName)} (${definitions.join(', ')})`
}

function normalizeStatement(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '')
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex.toUpperCase()
}
