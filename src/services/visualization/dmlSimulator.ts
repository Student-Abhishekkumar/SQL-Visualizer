/**
 * Isolated INSERT / UPDATE / DELETE preview (Stage 8D).
 *
 * Safety boundary: the active SQLite connection is only ever *read* to
 * export its bytes. Every preview statement executes against an
 * independent in-memory copy created from those bytes, and that copy is
 * closed on success and failure. The active database, its persisted
 * IndexedDB snapshot and the active database selection are never touched.
 *
 * The logical prediction (rows this statement should insert, change or
 * delete) is compared with the isolated copy's real final table. A preview
 * is never reported as validated without that comparison.
 */

import { SQLiteDatabase } from '../database/sqliteService'
import { quoteIdentifier, quoteLiteral } from '../database/schemaService'
import { parseSql } from '../sql/sqlParser'
import { analyzeDmlCapability } from './capabilityAnalyzer'
import type { Expression } from './astInterpreter'
import { interpretDml, type SupportedDml } from './dmlInterpreter'
import { evaluateCondition, evaluateExpression, type RowContext } from './expressionEvaluator'
import { rowKey } from './rowIdentity'
import { simulateSql, type SimulationOptions, type SimulationOutcome, type TableData } from './simulator'
import {
  deriveAffinity,
  normalizeCollation,
  numberToSqliteText,
  isWellFormedNumericText,
  type ColumnMeta,
  type SqliteAffinity,
} from './sqliteAffinity'
import { compareSimulationWithSqlite } from './validation'
import type {
  DmlColumnMapping,
  DmlTraceInfo,
  RowRole,
  StageSnapshot,
  ValidationResult,
  VisualizedRow,
  VisualizedStage,
  VisualizationEvent,
  VisualizationTrace,
} from '../../types/visualization'

const DISPLAY_ROW_LIMIT = 500

export interface DmlPreviewOutcome {
  simulation: SimulationOutcome
  execution: { columns: string[]; values: unknown[][] } | null
  validation: ValidationResult | null
}

interface DmlRow {
  rowid: unknown
  row: VisualizedRow
}

interface TargetInfo {
  name: string
  columns: string[]
  insertableColumns: string[]
  primaryKeys: Set<string>
  rowidName: string
  rowidAliasColumn: string | null
  columnMeta: ColumnMeta[]
}

interface Capture {
  info: TargetInfo
  rows: DmlRow[]
}

interface InputData {
  columns: string[]
  rows: unknown[][]
}

interface MappingResult {
  mappings: DmlColumnMapping[]
  /** Target column index → input value index. */
  targetToInput: Map<number, number>
  inputColumns: string[]
}

interface BuiltPreview {
  stages: VisualizedStage[]
  snapshots: StageSnapshot[]
  events: VisualizationEvent[]
  dml: DmlTraceInfo
  predictedFinal: VisualizedRow[]
  finalColumns: string[]
}

class PreviewReject extends Error {}

function failure(reasons: string[]): DmlPreviewOutcome {
  return { simulation: { ok: false, reasons }, execution: null, validation: null }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function visualRow(table: string, rowid: unknown, values: unknown[]): DmlRow {
  return { rowid, row: { id: `${table}:${rowKey([rowid])}`, values } }
}

interface RawColumnDefinition {
  column?: { column?: unknown } | string
  collate?: { collate?: { name?: unknown }; name?: unknown } | null
}

/** Declared collations keyed case-insensitively by column name. */
function declaredCollations(ast: unknown): Map<string, string> {
  const collations = new Map<string, string>()
  if (ast === null || typeof ast !== 'object') return collations
  const definitions = (ast as { create_definitions?: unknown }).create_definitions
  if (!Array.isArray(definitions)) return collations
  for (const definition of definitions as RawColumnDefinition[]) {
    const rawName = typeof definition.column === 'string'
      ? definition.column
      : definition.column?.column
    const name = typeof rawName === 'string' ? rawName : null
    const rawCollation = definition.collate?.collate?.name ?? definition.collate?.name
    if (name !== null && typeof rawCollation === 'string' && rawCollation !== '') {
      collations.set(name.toLowerCase(), rawCollation)
    }
  }
  return collations
}

/** Real table rows plus comparison metadata, read from an isolated copy. */
function readTable(db: SQLiteDatabase, name: string): TableData | null {
  try {
    const quotedName = quoteIdentifier(name)
    const result = db.queryAll(`SELECT * FROM ${quotedName}`)
    const tableInfo = db.queryAll(`PRAGMA table_info(${quotedName})`)
    const createSql = db.queryOne(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${quoteLiteral(name)}`,
    )?.row[0]
    const collations = declaredCollations(
      typeof createSql === 'string' ? parseSql(createSql) : null,
    )
    const infoByName = new Map(
      tableInfo.values.map((row) => [String(row[1] ?? '').toLowerCase(), row] as const),
    )
    const columnMeta: Array<ColumnMeta | null> = result.columns.map((column) => {
      const info = infoByName.get(column.toLowerCase())
      if (info === undefined) return null
      const affinity = deriveAffinity(String(info[2] ?? ''))
      const declared = collations.get(column.toLowerCase())
      if (declared === undefined) return { affinity, collation: 'BINARY' }
      const collation = normalizeCollation(declared)
      return collation === null
        ? { affinity, collation: 'BINARY', unsupportedCollation: declared }
        : { affinity, collation }
    })
    return {
      columns: [...result.columns],
      rows: result.values.map((row) => [...row]),
      columnMeta,
    }
  } catch {
    return null
  }
}

function columnMetadata(
  db: SQLiteDatabase,
  name: string,
  columns: readonly string[],
): ColumnMeta[] {
  const quotedName = quoteIdentifier(name)
  const tableInfo = db.queryAll(`PRAGMA table_info(${quotedName})`)
  const createSql = db.queryOne(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${quoteLiteral(name)}`,
  )?.row[0]
  const collations = declaredCollations(
    typeof createSql === 'string' ? parseSql(createSql) : null,
  )
  const infoByName = new Map(
    tableInfo.values.map((row) => [String(row[1] ?? '').toLowerCase(), row] as const),
  )
  return columns.map((column) => {
    const info = infoByName.get(column.toLowerCase())
    const affinity = deriveAffinity(String(info?.[2] ?? ''))
    const declared = collations.get(column.toLowerCase())
    if (declared === undefined) return { affinity, collation: 'BINARY' }
    const collation = normalizeCollation(declared)
    return collation === null
      ? { affinity, collation: 'BINARY', unsupportedCollation: declared }
      : { affinity, collation }
  })
}

function resolveTarget(db: SQLiteDatabase, requestedName: string): TargetInfo {
  const catalog = db.queryOne(
    `SELECT name, type, sql FROM sqlite_master WHERE lower(name) = lower(${quoteLiteral(requestedName)})`,
  )
  if (catalog === null) throw new PreviewReject(`Target table "${requestedName}" does not exist.`)
  if (String(catalog.row[1]) !== 'table') {
    throw new PreviewReject(
      `DML preview target "${requestedName}" must be a table, not a view or other object.`,
    )
  }
  const name = String(catalog.row[0])
  if (/\bWITHOUT\s+ROWID\b/i.test(String(catalog.row[2] ?? ''))) {
    throw new PreviewReject('WITHOUT ROWID target tables are not supported by DML visualization yet.')
  }
  const trigger = db.queryOne(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) = lower(${quoteLiteral(name)}) LIMIT 1`,
  )
  if (trigger !== null) {
    throw new PreviewReject(
      `DML preview does not support target table "${name}" because triggers can mutate additional rows or tables.`,
    )
  }
  const info = db.queryAll(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).values
  if (info.length === 0) {
    throw new PreviewReject(`SQLite returned no column metadata for target table "${name}".`)
  }
  const generated = info.filter((row) => Number(row[6] ?? 0) >= 2)
  if (generated.length > 0) {
    throw new PreviewReject(
      `DML preview does not support target table "${name}" because generated columns cannot be predicted faithfully.`,
    )
  }
  const columns = info.filter((row) => Number(row[6] ?? 0) !== 1).map((row) => String(row[1]))
  const insertableColumns = info
    .filter((row) => Number(row[6] ?? 0) === 0)
    .map((row) => String(row[1]))
  const lower = new Set(columns.map((column) => column.toLowerCase()))
  const rowidName = ['rowid', '_rowid_', 'oid'].find((candidate) => !lower.has(candidate))
  if (rowidName === undefined) {
    throw new PreviewReject(
      'The target table shadows every SQLite rowid alias, so stable preview identities are unavailable.',
    )
  }
  const primaryKeyRows = info.filter((row) => Number(row[5] ?? 0) > 0)
  const rowidAliasRow =
    primaryKeyRows.length === 1 &&
    String(primaryKeyRows[0]?.[2] ?? '').trim().toUpperCase() === 'INTEGER'
      ? primaryKeyRows[0]
      : undefined
  return {
    name,
    columns,
    insertableColumns,
    primaryKeys: new Set(
      info.filter((row) => Number(row[5] ?? 0) > 0).map((row) => String(row[1]).toLowerCase()),
    ),
    rowidName,
    rowidAliasColumn: rowidAliasRow !== undefined ? String(rowidAliasRow[1]) : null,
    columnMeta: columnMetadata(db, name, columns),
  }
}

function rejectCascades(db: SQLiteDatabase, target: string): void {
  const tables = db.queryAll(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).values
  for (const row of tables) {
    const table = String(row[0])
    for (const foreignKey of db.queryAll(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).values) {
      const referenced = String(foreignKey[2])
      const update = String(foreignKey[5]).toUpperCase()
      const remove = String(foreignKey[6]).toUpperCase()
      if (
        (table.toLowerCase() === target.toLowerCase() ||
          referenced.toLowerCase() === target.toLowerCase()) &&
        ((update !== 'NO ACTION' && update !== 'RESTRICT') ||
          (remove !== 'NO ACTION' && remove !== 'RESTRICT'))
      ) {
        throw new PreviewReject(
          'Foreign-key CASCADE/SET NULL/SET DEFAULT actions are not supported because they can mutate rows outside the explained target table.',
        )
      }
    }
  }
}

function capture(db: SQLiteDatabase, info: TargetInfo): Capture {
  const selected = [info.rowidName, ...info.columns].map(quoteIdentifier).join(', ')
  const result = db.queryAll(
    `SELECT ${selected} FROM ${quoteIdentifier(info.name)} ORDER BY ${quoteIdentifier(info.rowidName)}`,
  )
  if (result.values.length > DISPLAY_ROW_LIMIT) {
    throw new PreviewReject(`DML preview supports target tables with at most ${DISPLAY_ROW_LIMIT} rows after the statement; this table has ${result.values.length}. The active database was not changed.`)
  }
  const rows = result.values.map((row) => visualRow(info.name, row[0], row.slice(1)))
  return { info, rows }
}

function defaultValues(db: SQLiteDatabase, info: TargetInfo): unknown[] {
  const quotedName = quoteIdentifier(info.name)
  const tableInfo = db.queryAll(`PRAGMA table_info(${quotedName})`).values
  const byName = new Map(
    tableInfo.map((row) => [String(row[1] ?? '').toLowerCase(), row] as const),
  )
  return info.columns.map((column) => {
    const row = byName.get(column.toLowerCase())
    const expression = row?.[4]
    if (typeof expression !== 'string' || expression.trim() === '') return null
    try {
      return db.queryOne(`SELECT (${expression})`)?.row[0] ?? null
    } catch {
      throw new PreviewReject(
        `The default value for column "${column}" could not be evaluated in the isolated preview.`,
      )
    }
  })
}

/** SQLite storage-class conversion applied when a value is written to a column. */
function storeValue(value: unknown, affinity: SqliteAffinity, kind?: 'integer' | 'real'): unknown {
  if (value === null || value === undefined) return null
  if (affinity === 'BLOB') return value
  if (affinity === 'TEXT') {
    if (typeof value === 'number' || typeof value === 'bigint') {
      return numberToSqliteText(value, kind)
    }
    if (typeof value === 'boolean') return value ? '1' : '0'
    return value
  }
  if (affinity === 'INTEGER' || affinity === 'REAL' || affinity === 'NUMERIC') {
    if (typeof value === 'string' && isWellFormedNumericText(value)) return Number(value.trim())
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'bigint') return Number(value)
    return value
  }
  return value
}

function numberKindOf(expr: Expression): 'integer' | 'real' | undefined {
  if (expr.kind === 'literal') return expr.numberKind
  if (expr.kind === 'unary_minus') return numberKindOf(expr.operand)
  if (expr.kind === 'collate') return numberKindOf(expr.operand)
  return undefined
}

function evaluateValue(expr: Expression, ctx: RowContext): unknown {
  return evaluateExpression(expr, ctx)
}

function emptyContext(): RowContext {
  return { columns: [], values: [] }
}

function evalContext(info: TargetInfo, values: unknown[]): RowContext {
  return {
    columns: info.columns.map((column) => `${info.name}.${column}`),
    values,
    columnMeta: info.columnMeta,
  }
}

function matchesWhere(info: TargetInfo, row: DmlRow, where: Expression | null): boolean {
  if (where === null) return true
  return evaluateCondition(where, evalContext(info, row.row.values)) === 'true'
}

function mappingForInsert(info: TargetInfo, statement: Extract<SupportedDml, { kind: 'INSERT' }>): MappingResult {
  const mappings: DmlColumnMapping[] = []
  const targetToInput = new Map<number, number>()

  if (statement.input.kind === 'DEFAULT VALUES') {
    for (const column of info.insertableColumns) {
      mappings.push({
        inputIndex: null,
        inputColumn: null,
        targetColumn: column,
        targetIndex: info.columns.indexOf(column),
      })
    }
    return { mappings, targetToInput, inputColumns: info.insertableColumns }
  }

  if (statement.columns !== null) {
    for (const [index, requested] of statement.columns.entries()) {
      const targetIndex = info.insertableColumns.findIndex(
        (column) => column.toLowerCase() === requested.toLowerCase(),
      )
      if (targetIndex < 0) {
        throw new PreviewReject(
          `INSERT column "${requested}" does not exist in target table "${info.name}" or is not insertable.`,
        )
      }
      const targetColumn = info.insertableColumns[targetIndex] as string
      mappings.push({
        inputIndex: index,
        inputColumn: requested,
        targetColumn,
        targetIndex: info.columns.indexOf(targetColumn),
      })
      targetToInput.set(info.columns.indexOf(targetColumn), index)
    }
    return {
      mappings,
      targetToInput,
      inputColumns: [...statement.columns],
    }
  }

  const positionalMappings = info.insertableColumns.map((column, inputIndex) => ({
    inputIndex,
    inputColumn: column,
    targetColumn: column,
    targetIndex: info.columns.indexOf(column),
  }))
  for (const mapping of positionalMappings) targetToInput.set(mapping.targetIndex, mapping.inputIndex)
  return {
    mappings: positionalMappings,
    targetToInput,
    inputColumns: info.insertableColumns,
  }
}

function inputRowsForInsert(
  db: SQLiteDatabase,
  info: TargetInfo,
  statement: Extract<SupportedDml, { kind: 'INSERT' }>,
  options: SimulationOptions,
): InputData {
  if (statement.input.kind === 'DEFAULT VALUES') {
    return { columns: info.insertableColumns, rows: [defaultValues(db, info)] }
  }
  if (statement.input.kind === 'SELECT') {
    const simulation = simulateSql(
      statement.input.sql,
      [statement.input.sql],
      (name) => readTable(db, name),
      options,
    )
    if (!simulation.ok) {
      throw new PreviewReject(
        `The INSERT source SELECT is not visualizable: ${simulation.reasons.join('; ')}`,
      )
    }
    if (simulation.trace.incomplete === true || simulation.trace.truncated) {
      throw new PreviewReject('The INSERT source SELECT exceeds the visualization row limit, so the DML preview cannot claim complete parity.')
    }
    return {
      columns: [...simulation.trace.finalColumns],
      rows: simulation.trace.finalRows.map((row) => [...row.values]),
    }
  }

  const inputColumns =
    statement.columns !== null
      ? [...statement.columns]
      : statement.input.rows[0]?.map((_, index) => `column ${index + 1}`) ?? []
  const rows = statement.input.rows.map((expressions, rowIndex) => {
    if (expressions.length !== inputColumns.length) {
      throw new PreviewReject(
        `INSERT VALUES row ${rowIndex + 1} has ${expressions.length} value${expressions.length === 1 ? '' : 's'}, but ${inputColumns.length} column${inputColumns.length === 1 ? '' : 's'} were supplied.`,
      )
    }
    return expressions.map((expression) => evaluateValue(expression, emptyContext()))
  })
  return { columns: inputColumns, rows }
}

function predictedInsertRows(
  db: SQLiteDatabase,
  info: TargetInfo,
  captureBefore: Capture,
  mapping: MappingResult,
  input: InputData,
): VisualizedRow[] {
  if (mapping.mappings.length === 0) {
    // No explicit column list: values map positionally to insertable columns.
    if (input.rows.length > 0) {
      const first = input.rows[0] as unknown[]
      if (first.length !== info.insertableColumns.length) {
        throw new PreviewReject(
          `INSERT supplies ${first.length} value${first.length === 1 ? '' : 's'} but table "${info.name}" has ${info.insertableColumns.length} insertable column${info.insertableColumns.length === 1 ? '' : 's'}.`,
        )
      }
    }
    for (const [index, column] of info.insertableColumns.entries()) {
      mapping.targetToInput.set(info.columns.indexOf(column), index)
    }
  }

  const defaults = defaultValues(db, info)
  const nextRowid = (() => {
    let max = 0
    for (const row of captureBefore.rows) {
      if (typeof row.rowid === 'number' && row.rowid > max) max = row.rowid
    }
    return max + 1
  })()
  let rowidCursor = nextRowid

  return input.rows.map((inputValues, rowIndex) => {
    const values = info.columns.map((column, columnIndex) => {
      const inputIndex = mapping.targetToInput.get(columnIndex)
      const affinity = info.columnMeta[columnIndex]?.affinity ?? null
      if (inputIndex !== undefined) {
        const expressionKind = undefined
        const value = inputValues[inputIndex]
        return storeValue(value, affinity ?? 'BLOB', expressionKind)
      }
      if (
        info.rowidAliasColumn !== null &&
        column.toLowerCase() === info.rowidAliasColumn.toLowerCase()
      ) {
        return rowidCursor++
      }
      const fallback = defaults[columnIndex] ?? null
      return storeValue(fallback, affinity ?? 'BLOB')
    })
    return {
      id: `predicted-insert:${rowIndex}`,
      values,
    }
  })
}

function predictedUpdateFinal(
  info: TargetInfo,
  before: DmlRow[],
  statement: Extract<SupportedDml, { kind: 'UPDATE' }>,
): { finalRows: VisualizedRow[]; matched: DmlRow[]; changed: DmlRow[]; unchanged: DmlRow[]; afterValues: Map<string, unknown[]> } {
  const matched: DmlRow[] = []
  const changed: DmlRow[] = []
  const unchanged: DmlRow[] = []
  const afterValues = new Map<string, unknown[]>()
  const finalRows: VisualizedRow[] = []

  for (const row of before) {
    if (!matchesWhere(info, row, statement.where)) {
      finalRows.push({ id: row.row.id, values: [...row.row.values] })
      continue
    }
    matched.push(row)
    const next = [...row.row.values]
    for (const assignment of statement.assignments) {
      const targetIndex = info.columns.findIndex(
        (column) => column.toLowerCase() === assignment.column.toLowerCase(),
      )
      if (targetIndex < 0) {
        throw new PreviewReject(
          `UPDATE SET column "${assignment.column}" does not exist in target table "${info.name}".`,
        )
      }
      if (
        info.rowidAliasColumn !== null &&
        assignment.column.toLowerCase() === info.rowidAliasColumn.toLowerCase()
      ) {
        throw new PreviewReject(
          'UPDATE preview cannot assign the INTEGER PRIMARY KEY / rowid column, because that changes stable row identity.',
        )
      }
      const value = evaluateValue(assignment.expression, evalContext(info, row.row.values))
      next[targetIndex] = storeValue(
        value,
        info.columnMeta[targetIndex]?.affinity ?? 'BLOB',
        numberKindOf(assignment.expression),
      )
    }
    if (rowKey(next) === rowKey(row.row.values)) {
      unchanged.push(row)
    } else {
      changed.push(row)
    }
    afterValues.set(row.row.id, next)
    finalRows.push({ id: row.row.id, values: next })
  }

  return { finalRows, matched, changed, unchanged, afterValues }
}

function predictedDeleteFinal(
  info: TargetInfo,
  before: DmlRow[],
  statement: Extract<SupportedDml, { kind: 'DELETE' }>,
): { finalRows: VisualizedRow[]; matched: DmlRow[]; retained: DmlRow[] } {
  const matched: DmlRow[] = []
  const retained: DmlRow[] = []
  for (const row of before) {
    if (matchesWhere(info, row, statement.where)) matched.push(row)
    else retained.push(row)
  }
  return {
    finalRows: retained.map((row) => ({ id: row.row.id, values: [...row.row.values] })),
    matched,
    retained,
  }
}

function rolesFor(rows: readonly DmlRow[], role: RowRole): Record<string, RowRole> {
  const roles: Record<string, RowRole> = {}
  for (const row of rows) roles[row.row.id] = role
  return roles
}

function snapshot(
  stage: VisualizedStage,
  label: string,
  columns: string[],
  rows: VisualizedRow[],
  removedRows: VisualizedRow[],
  roles: Record<string, RowRole>,
  explanation: string,
  inputRowCount: number,
): StageSnapshot {
  return {
    stage,
    label,
    columns,
    rows,
    removedRows,
    roles,
    groups: [],
    explanation,
    inputRowCount,
    outputRowCount: rows.length,
    truncated: false,
  }
}

function buildEvents(query: string, snapshots: readonly StageSnapshot[], operation: string): VisualizationEvent[] {
  const events: VisualizationEvent[] = [
    {
      id: 'dml-started',
      type: 'QUERY_STARTED',
      description: `Preparing an isolated ${operation} preview for ${query.trim()}.`,
      stage: null,
    },
  ]
  snapshots.forEach((snap, index) => {
    events.push({
      id: `dml-stage-${index + 1}`,
      type: 'STAGE_COMPLETED',
      description: snap.explanation,
      stage: snap.stage,
      snapshot: snap,
    })
  })
  events.push({
    id: 'dml-completed',
    type: 'QUERY_VISUALIZATION_COMPLETED',
    description:
      'Preview complete. The isolated copy was discarded; the active database was not changed.',
    stage: null,
  })
  return events
}

function changedRowsBetween(before: Capture, after: Capture): {
  inserted: DmlRow[]
  deleted: DmlRow[]
  changed: DmlRow[]
  unchanged: DmlRow[]
} {
  const beforeById = new Map(before.rows.map((row) => [String(row.rowid), row] as const))
  const afterById = new Map(after.rows.map((row) => [String(row.rowid), row] as const))
  const inserted: DmlRow[] = []
  const deleted: DmlRow[] = []
  const changed: DmlRow[] = []
  const unchanged: DmlRow[] = []

  for (const row of after.rows) {
    const previous = beforeById.get(String(row.rowid))
    if (previous === undefined) {
      inserted.push(row)
    } else if (rowKey(previous.row.values) === rowKey(row.row.values)) {
      unchanged.push(row)
    } else {
      changed.push(row)
    }
  }
  for (const row of before.rows) {
    if (!afterById.has(String(row.rowid))) deleted.push(row)
  }
  return { inserted, deleted, changed, unchanged }
}

function buildInsertPreview(
  db: SQLiteDatabase,
  statement: Extract<SupportedDml, { kind: 'INSERT' }>,
  before: Capture,
  after: Capture,
  options: SimulationOptions,
): BuiltPreview {
  const info = before.info
  const mapping = mappingForInsert(info, statement)
  const input = inputRowsForInsert(db, info, statement, options)
  const predicted = predictedInsertRows(db, info, before, mapping, input)
  const actual = changedRowsBetween(before, after)
  const inserted = actual.inserted
  const inputRows: VisualizedRow[] = input.rows.map((values, index) => ({
    id: `input:${index}`,
    values: [...values],
  }))
  const mappingRows: VisualizedRow[] = mapping.mappings.map((mappingRow, index) => ({
    id: `mapping:${index}`,
    values: [
      mappingRow.inputIndex === null ? null : mappingRow.inputIndex + 1,
      mappingRow.inputColumn,
      mappingRow.targetColumn,
      mappingRow.targetIndex + 1,
    ],
  }))
  const beforeRows = before.rows.map((row) => row.row)
  const afterRows = after.rows.map((row) => row.row)
  const snapshots = [
    snapshot(
      'TARGET',
      `Target table · ${info.name} (${beforeRows.length} rows before)`,
      info.columns,
      beforeRows,
      [],
      rolesFor(before.rows, 'unchanged'),
      `The target table currently contains ${beforeRows.length} row${beforeRows.length === 1 ? '' : 's'} in the isolated copy.`,
      0,
    ),
    snapshot(
      'INPUT',
      `Input rows (${inputRows.length})`,
      input.columns,
      inputRows,
      [],
      rolesFor(inputRows.map((row) => ({ rowid: row.id, row })), 'accepted'),
      `${inputRows.length} input row${inputRows.length === 1 ? '' : 's'} will be mapped to target columns.`,
      0,
    ),
    snapshot(
      'COLUMN_MAPPING',
      `Column mapping (${mappingRows.length})`,
      ['input position', 'input column', 'target column', 'target position'],
      mappingRows,
      [],
      rolesFor(mappingRows.map((row) => ({ rowid: row.id, row })), 'mapped'),
      'Each input value is mapped to its target column; omitted columns receive their declared default.',
      inputRows.length,
    ),
    snapshot(
      'INSERT',
      `Inserted rows (${inserted.length})`,
      info.columns,
      inserted.map((row) => row.row),
      [],
      rolesFor(inserted, 'inserted'),
      `SQLite inserted ${inserted.length} row${inserted.length === 1 ? '' : 's'} into the isolated copy.`,
      0,
    ),
    snapshot(
      'FINAL_TABLE',
      `Final table (${afterRows.length} rows after preview)`,
      info.columns,
      afterRows,
      [],
      rolesFor(after.rows, 'unchanged'),
      `The isolated table now has ${afterRows.length} row${afterRows.length === 1 ? '' : 's'}. The active database still has ${beforeRows.length}.`,
      beforeRows.length,
    ),
  ]
  const dml: DmlTraceInfo = {
    operation: 'INSERT',
    targetTable: info.name,
    inputKind: statement.input.kind,
    columnMappings: mapping.mappings,
    matchedRowIds: [],
    changedRowIds: [],
    unchangedRowIds: [],
    insertedRowIds: inserted.map((row) => row.row.id),
    deletedRowIds: [],
    affectedRowCount: inserted.length,
    finalRowCount: afterRows.length,
  }
  return {
    stages: snapshots.map((snap) => snap.stage),
    snapshots,
    events: buildEvents(statement.sql, snapshots, 'INSERT'),
    dml,
    // Final prediction = the real pre-statement rows plus the predicted
    // inserted rows, compared against the isolated copy's actual final table.
    predictedFinal: [...beforeRows, ...predicted],
    finalColumns: info.columns,
  }
}

function buildUpdatePreview(
  statement: Extract<SupportedDml, { kind: 'UPDATE' }>,
  before: Capture,
  after: Capture,
): BuiltPreview {
  const info = before.info
  const prediction = predictedUpdateFinal(info, before.rows, statement)
  const actual = changedRowsBetween(before, after)
  const matchedIds = new Set(prediction.matched.map((row) => row.row.id))
  const actualAfterById = new Map(after.rows.map((row) => [row.row.id, row] as const))
  const matchedAfterRows = prediction.matched
    .map((row) => actualAfterById.get(row.row.id))
    .filter((row): row is DmlRow => row !== undefined)
  const changedAfter = actual.changed.filter((row) => matchedIds.has(row.row.id))
  const unchangedAfter = actual.unchanged.filter((row) => matchedIds.has(row.row.id))
  const beforeRows = before.rows.map((row) => row.row)
  const afterRows = after.rows.map((row) => row.row)
  const setRoles: Record<string, RowRole> = {}
  for (const row of matchedAfterRows) {
    setRoles[row.row.id] = changedAfter.some((candidate) => candidate.row.id === row.row.id)
      ? 'changed'
      : 'unchanged'
  }
  const unmatched = before.rows.filter((row) => !matchedIds.has(row.row.id))
  const snapshots = [
    snapshot(
      'TARGET',
      `Target table · ${info.name} (${beforeRows.length} rows before)`,
      info.columns,
      beforeRows,
      [],
      rolesFor(before.rows, 'unchanged'),
      `The target table currently contains ${beforeRows.length} row${beforeRows.length === 1 ? '' : 's'} in the isolated copy.`,
      0,
    ),
    snapshot(
      'MATCHED_ROWS',
      `Matched rows (${prediction.matched.length})`,
      info.columns,
      prediction.matched.map((row) => row.row),
      unmatched.map((row) => row.row),
      {
        ...rolesFor(prediction.matched, 'accepted'),
        ...rolesFor(unmatched, 'filtered'),
      },
      `${prediction.matched.length} row${prediction.matched.length === 1 ? '' : 's'} matched the WHERE condition; ${unmatched.length} did not.`,
      beforeRows.length,
    ),
    snapshot(
      'SET',
      `New values (${changedAfter.length} changed, ${unchangedAfter.length} unchanged)`,
      info.columns,
      matchedAfterRows.map((row) => row.row),
      [],
      setRoles,
      'Each matched row is assigned the SET expressions; SQLite evaluates every assignment against the row’s original values.',
      prediction.matched.length,
    ),
    snapshot(
      'CHANGED_ROWS',
      `Changed rows (${changedAfter.length})`,
      info.columns,
      changedAfter.map((row) => row.row),
      [],
      rolesFor(changedAfter, 'changed'),
      `${changedAfter.length} row${changedAfter.length === 1 ? '' : 's'} stored a different value after the assignment.`,
      prediction.matched.length,
    ),
    snapshot(
      'UNCHANGED_ROWS',
      `Unchanged rows (${unchangedAfter.length})`,
      info.columns,
      unchangedAfter.map((row) => row.row),
      [],
      rolesFor(unchangedAfter, 'unchanged'),
      `${unchangedAfter.length} matched row${unchangedAfter.length === 1 ? '' : 's'} already held the assigned values.`,
      prediction.matched.length,
    ),
    snapshot(
      'FINAL_TABLE',
      `Final table (${afterRows.length} rows after preview)`,
      info.columns,
      afterRows,
      [],
      {
        ...rolesFor(after.rows.filter((row) => changedAfter.some((c) => c.row.id === row.row.id)), 'changed'),
        ...rolesFor(after.rows.filter((row) => !changedAfter.some((c) => c.row.id === row.row.id)), 'unchanged'),
      },
      `The isolated table now has ${afterRows.length} row${afterRows.length === 1 ? '' : 's'}. The active database was not updated.`,
      beforeRows.length,
    ),
  ]
  const dml: DmlTraceInfo = {
    operation: 'UPDATE',
    targetTable: info.name,
    inputKind: 'TABLE',
    columnMappings: [],
    matchedRowIds: prediction.matched.map((row) => row.row.id),
    changedRowIds: changedAfter.map((row) => row.row.id),
    unchangedRowIds: unchangedAfter.map((row) => row.row.id),
    insertedRowIds: [],
    deletedRowIds: [],
    affectedRowCount: prediction.matched.length,
    finalRowCount: afterRows.length,
  }
  return {
    stages: snapshots.map((snap) => snap.stage),
    snapshots,
    events: buildEvents(statement.sql, snapshots, 'UPDATE'),
    dml,
    predictedFinal: prediction.finalRows,
    finalColumns: info.columns,
  }
}

function buildDeletePreview(
  statement: Extract<SupportedDml, { kind: 'DELETE' }>,
  before: Capture,
  after: Capture,
): BuiltPreview {
  const info = before.info
  const prediction = predictedDeleteFinal(info, before.rows, statement)
  const actual = changedRowsBetween(before, after)
  const beforeRows = before.rows.map((row) => row.row)
  const afterRows = after.rows.map((row) => row.row)
  const matched = prediction.matched
  const retained = prediction.retained
  const snapshots = [
    snapshot(
      'TARGET',
      `Target table · ${info.name} (${beforeRows.length} rows before)`,
      info.columns,
      beforeRows,
      [],
      rolesFor(before.rows, 'unchanged'),
      `The target table currently contains ${beforeRows.length} row${beforeRows.length === 1 ? '' : 's'} in the isolated copy.`,
      0,
    ),
    snapshot(
      'MATCHED_ROWS',
      `Matched rows (${matched.length})`,
      info.columns,
      matched.map((row) => row.row),
      retained.map((row) => row.row),
      {
        ...rolesFor(matched, 'accepted'),
        ...rolesFor(retained, 'unchanged'),
      },
      `${matched.length} row${matched.length === 1 ? '' : 's'} matched the WHERE condition; ${retained.length} will be retained.`,
      beforeRows.length,
    ),
    snapshot(
      'DELETE',
      `Deleted rows (${actual.deleted.length})`,
      info.columns,
      actual.deleted.map((row) => row.row),
      [],
      rolesFor(actual.deleted, 'deleted'),
      `SQLite deleted ${actual.deleted.length} row${actual.deleted.length === 1 ? '' : 's'} from the isolated copy.`,
      matched.length,
    ),
    snapshot(
      'RETAINED_ROWS',
      `Retained rows (${afterRows.length})`,
      info.columns,
      afterRows,
      [],
      rolesFor(after.rows, 'retained'),
      `${afterRows.length} row${afterRows.length === 1 ? '' : 's'} remain in the isolated table.`,
      afterRows.length,
    ),
    snapshot(
      'FINAL_TABLE',
      `Final table (${afterRows.length} rows after preview)`,
      info.columns,
      afterRows,
      [],
      rolesFor(after.rows, 'retained'),
      `The isolated table now has ${afterRows.length} row${afterRows.length === 1 ? '' : 's'}. The active database still has ${beforeRows.length}.`,
      beforeRows.length,
    ),
  ]
  const dml: DmlTraceInfo = {
    operation: 'DELETE',
    targetTable: info.name,
    inputKind: 'TABLE',
    columnMappings: [],
    matchedRowIds: matched.map((row) => row.row.id),
    changedRowIds: [],
    unchangedRowIds: [],
    insertedRowIds: [],
    deletedRowIds: actual.deleted.map((row) => row.row.id),
    affectedRowCount: actual.deleted.length,
    finalRowCount: afterRows.length,
  }
  return {
    stages: snapshots.map((snap) => snap.stage),
    snapshots,
    events: buildEvents(statement.sql, snapshots, 'DELETE'),
    dml,
    predictedFinal: prediction.finalRows,
    finalColumns: info.columns,
  }
}

/**
 * Run a DML preview entirely on an isolated copy of `activeDb`.
 *
 * The active connection is read once (`exportSnapshot`) and never passed
 * to the preview executor. The temporary connection is always closed.
 */
export function previewDml(
  sql: string,
  statements: string[],
  activeDb: SQLiteDatabase,
  options: SimulationOptions = {},
): DmlPreviewOutcome {
  const interpretation = interpretDml(statements)
  if (!interpretation.supported) return failure(interpretation.reasons)
  const statement = interpretation.statement

  let clone: SQLiteDatabase | null = null
  try {
    clone = SQLiteDatabase.createFromSnapshot(activeDb.exportSnapshot())
    const info = resolveTarget(clone, statement.table)
    rejectCascades(clone, info.name)
    const before = capture(clone, info)

    let built: BuiltPreview
    let rowsModified: number
    if (statement.kind === 'INSERT') {
      const input = inputRowsForInsert(clone, info, statement, options)
      const mapping = mappingForInsert(info, statement)
      // Validate input shape before executing anything.
      predictedInsertRows(clone, info, before, mapping, input)
      rowsModified = 0
      const result = clone.executeBatch(statement.sql)
      rowsModified = result[0]?.rowsModified ?? 0
      const after = capture(clone, info)
      built = buildInsertPreview(clone, statement, before, after, options)
      // Keep the authoritative SQLite affected count.
      built.dml.affectedRowCount = rowsModified
    } else if (statement.kind === 'UPDATE') {
      predictedUpdateFinal(info, before.rows, statement)
      const result = clone.executeBatch(statement.sql)
      rowsModified = result[0]?.rowsModified ?? 0
      const after = capture(clone, info)
      built = buildUpdatePreview(statement, before, after)
      built.dml.affectedRowCount = rowsModified
    } else {
      predictedDeleteFinal(info, before.rows, statement)
      const result = clone.executeBatch(statement.sql)
      rowsModified = result[0]?.rowsModified ?? 0
      const after = capture(clone, info)
      built = buildDeletePreview(statement, before, after)
      built.dml.affectedRowCount = rowsModified
    }

    const validation = compareSimulationWithSqlite(
      {
        finalColumns: built.finalColumns,
        finalRows: built.predictedFinal,
        hasDeterministicOrder: false,
      },
      {
        columns: built.finalColumns,
        values: built.snapshots[built.snapshots.length - 1]?.rows.map((row) => [...row.values]) ?? [],
      },
    )

    if (!validation.validated) {
      return failure([`The isolated DML preview did not match SQLite and was discarded: ${validation.detail ?? 'unknown parity mismatch'}`])
    }

    const target = built.snapshots[0]
    const trace: VisualizationTrace = {
      query: sql,
      statementType: statement.kind,
      capability: analyzeDmlCapability(statement),
      rootBlockId: 'q1',
      stages: built.stages,
      events: built.events,
      stageSnapshots: built.snapshots,
      sourceTables: target === undefined ? [] : [{
        name: built.dml.targetTable,
        alias: null,
        columns: target.columns,
        rowCount: target.rows.length,
        previewRows: target.rows,
        role: 'from',
        joinType: null,
        on: null,
        consumerStage: 'TARGET',
      }],
      dml: built.dml,
      totalSteps: built.events.length,
      finalRows: built.snapshots[built.snapshots.length - 1]?.rows ?? [],
      finalColumns: built.finalColumns,
      hasDeterministicOrder: false,
      truncated: false,
    }

    return {
      simulation: { ok: true, trace },
      execution: null,
      validation,
    }
  } catch (error) {
    if (error instanceof PreviewReject) return failure([error.message])
    return failure([`The isolated DML preview could not run: ${messageOf(error)}`])
  } finally {
    clone?.close()
  }
}
