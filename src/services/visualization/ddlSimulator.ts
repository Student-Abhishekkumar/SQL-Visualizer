/**
 * Isolated DDL schema preview (Stage 8E).
 *
 * The active connection is used only to export bytes. Statements execute on
 * an independent clone, all schema metadata is read back from SQLite, and
 * the clone closes on every path. No preview state is persisted.
 */
import { SQLiteDatabase } from '../database/sqliteService'
import { analyzeDdlCapability } from './capabilityAnalyzer'
import { interpretDdl, type SupportedDdl } from './ddlInterpreter'
import { captureDdlSchema, readDdlTable } from './ddlSchema'
import { rowsMatchUnordered } from './rowIdentity'
import type { SimulationOutcome } from './simulator'
import type {
  DdlSchemaState,
  DdlIndexState,
  DdlTableState,
  DdlTraceInfo,
  RowRole,
  StageSnapshot,
  ValidationResult,
  VisualizedRow,
  VisualizedStage,
  VisualizationEvent,
  VisualizationTrace,
} from '../../types/visualization'

export interface DdlPreviewOutcome {
  simulation: SimulationOutcome
  execution: { columns: string[]; values: unknown[][] } | null
  validation: ValidationResult | null
}

class PreviewReject extends Error {}

function failure(reasons: string[]): DdlPreviewOutcome {
  return { simulation: { ok: false, reasons }, execution: null, validation: null }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function objectTypeOf(statement: SupportedDdl): 'TABLE' | 'INDEX' {
  return statement.operation === 'CREATE_INDEX' || statement.operation === 'DROP_INDEX' ? 'INDEX' : 'TABLE'
}

function objectNameOf(statement: SupportedDdl): string {
  return statement.operation === 'CREATE_INDEX' || statement.operation === 'DROP_INDEX'
    ? statement.index
    : statement.table
}

function beforeSchema(db: SQLiteDatabase, statement: SupportedDdl): DdlSchemaState {
  return captureDdlSchema(
    db,
    objectTypeOf(statement),
    objectNameOf(statement),
    statement.operation === 'CREATE_INDEX' ? statement.table : undefined,
  )
}

function afterSchema(db: SQLiteDatabase, statement: SupportedDdl, before: DdlSchemaState): DdlSchemaState {
  const afterName = statement.operation === 'ALTER_TABLE' && statement.action.kind === 'RENAME_TABLE'
    ? statement.action.newTable
    : objectNameOf(statement)
  return captureDdlSchema(
    db,
    objectTypeOf(statement),
    afterName,
    statement.operation === 'CREATE_INDEX' || statement.operation === 'DROP_INDEX'
      ? statement.operation === 'CREATE_INDEX' ? statement.table : before.table?.name
      : undefined,
  )
}

function rows(values: unknown[][], stage: VisualizedStage, role: RowRole = 'unchanged'): {
  rows: VisualizedRow[]
  roles: Record<string, RowRole>
} {
  const roles: Record<string, RowRole> = {}
  const visualized = values.map((row, index) => {
    const id = `ddl:${stage}:${index}`
    roles[id] = role
    return { id, values: [...row] }
  })
  return { rows: visualized, roles }
}

function snapshot(
  stage: VisualizedStage,
  label: string,
  columns: string[],
  values: unknown[][],
  schema: DdlSchemaState,
  explanation: string,
  inputRowCount: number,
  role: RowRole = 'unchanged',
): StageSnapshot {
  const data = rows(values, stage, role)
  return {
    stage,
    blockId: 'q1',
    label,
    columns,
    rows: data.rows,
    removedRows: [],
    roles: data.roles,
    groups: [],
    explanation,
    inputRowCount,
    outputRowCount: data.rows.length,
    truncated: false,
    schema,
  }
}

const CATALOG_COLUMNS = ['type', 'name', 'table', 'sql']
const TABLE_COLUMNS = ['table', 'create_sql', 'row_count']
const COLUMN_COLUMNS = ['column', 'declared_type', 'affinity', 'not_null', 'pk_position', 'default_sql', 'unique']
const CONSTRAINT_COLUMNS = ['kind', 'name', 'columns', 'details']
const INDEX_COLUMNS = ['index', 'table', 'unique', 'origin', 'columns', 'create_sql']

function catalogValues(schema: DdlSchemaState): unknown[][] {
  return schema.catalog.map((object) => [object.type, object.name, object.tableName, object.sql])
}

function tableValues(table: DdlTableState | null): unknown[][] {
  return table === null ? [] : [[table.name, table.sql, table.rowCount]]
}

function columnValues(table: DdlTableState | null): unknown[][] {
  return table?.columns.map((column) => [
    column.name, column.declaredType, column.affinity, column.notNull,
    column.primaryKeyPosition, column.defaultSql, column.unique,
  ]) ?? []
}

function constraintValues(table: DdlTableState | null): unknown[][] {
  if (table === null) return []
  const indexes = table.indexes.map((index) => [
    index.unique ? 'UNIQUE INDEX' : 'INDEX', index.name,
    index.columns.map((column) => column ?? '<expression>').join(', '), index.origin,
  ])
  const foreignKeys = table.columns.flatMap((column) => column.foreignKeys.map((foreignKey) => [
    'FOREIGN KEY', column.name, foreignKey.targetColumn ?? '',
    `${foreignKey.targetTable} · ON UPDATE ${foreignKey.onUpdate} · ON DELETE ${foreignKey.onDelete}`,
  ]))
  return [...indexes, ...foreignKeys]
}

interface BuiltPreview {
  snapshots: StageSnapshot[]
  ddl: DdlTraceInfo
}

function buildEvents(snapshots: readonly StageSnapshot[]): VisualizationEvent[] {
  const events: VisualizationEvent[] = [{
    id: 'ddl-started', type: 'QUERY_STARTED', stage: null,
    description: 'Preparing a DDL preview on an isolated database copy.',
  }]
  snapshots.forEach((snap, index) => events.push({
    id: `ddl-stage-${index + 1}`, type: 'STAGE_COMPLETED', stage: snap.stage,
    description: snap.explanation, snapshot: snap,
  }))
  events.push({
    id: 'ddl-completed', type: 'QUERY_VISUALIZATION_COMPLETED', stage: null,
    description: 'Schema preview complete. The isolated copy was discarded; the active database is unchanged.',
  })
  return events
}

function buildCreateTable(
  statement: Extract<SupportedDdl, { operation: 'CREATE_TABLE' }>,
  before: DdlSchemaState,
  after: DdlSchemaState,
  noOp: boolean,
): BuiltPreview {
  const table = after.table
  if (table === null) throw new PreviewReject(`SQLite did not produce table "${statement.table}" in the isolated preview.`)
  const name = table.name
  const noOpText = noOp ? ' IF NOT EXISTS found the existing table, so SQLite made no schema change.' : ''
  const snapshots = [
    snapshot('DATABASE', `Database schema before · ${before.catalog.length} objects`, CATALOG_COLUMNS,
      catalogValues(before), before, `The isolated copy starts with ${before.catalog.length} catalog objects.`, 0),
    snapshot('TABLE_DEFINITION', `Table definition · ${name}`, TABLE_COLUMNS,
      tableValues(table), after, noOp
        ? `The existing definition of "${name}" was retained.${noOpText}`
        : `SQLite created the table definition for "${name}" in the isolated copy.`, before.catalog.length),
    snapshot('COLUMN_DEFINITIONS', `Columns · ${table.columns.length}`, COLUMN_COLUMNS,
      columnValues(table), after, `PRAGMA table_xinfo reports ${table.columns.length} columns for "${name}".`, 1),
    snapshot('CONSTRAINTS', `Constraints and indexes · ${table.indexes.length}`, CONSTRAINT_COLUMNS,
      constraintValues(table), after, constraintValues(table).length === 0
        ? `SQLite reports no indexes or foreign keys for "${name}".`
        : 'Constraint and index metadata comes from PRAGMA index_list, index_xinfo, and foreign_key_list.', table.columns.length),
    snapshot('CREATE_TABLE', noOp ? `CREATE TABLE · no change` : `CREATE TABLE · ${name}`, TABLE_COLUMNS,
      tableValues(table), after, noOp
        ? `The statement was a no-op because "${name}" already exists.`
        : `CREATE TABLE succeeded on the isolated copy. The active database was not modified.`, 1, noOp ? 'unchanged' : 'inserted'),
    snapshot('RESULTING_SCHEMA', `Resulting schema · ${after.catalog.length} objects`, CATALOG_COLUMNS,
      catalogValues(after), after, `The resulting schema contains ${after.catalog.length} real SQLite catalog objects.${noOpText}`, 1),
  ]
  return {
    snapshots,
    ddl: {
      operation: 'CREATE_TABLE', objectType: 'TABLE', objectName: statement.table,
      targetTable: name, noOp, rowDataChanged: false, before, after,
    },
  }
}

function projectedRows(table: DdlTableState, keptColumns: string[]): unknown[][] {
  const indexes = keptColumns.map((column) => table.columns.findIndex(
    (candidate) => candidate.name.toLowerCase() === column.toLowerCase(),
  ))
  if (indexes.some((index) => index < 0)) return []
  return table.rows.map((row) => indexes.map((index) => row[index]))
}

function alterPreservesRows(
  statement: Extract<SupportedDdl, { operation: 'ALTER_TABLE' }>,
  before: DdlTableState,
  after: DdlTableState,
): boolean {
  if (statement.action.kind === 'RENAME_TABLE' || statement.action.kind === 'RENAME_COLUMN') {
    return rowsMatchUnordered(before.rows, after.rows)
  }
  if (statement.action.kind === 'ADD_COLUMN') {
    return rowsMatchUnordered(
      before.rows,
      projectedRows(after, before.columns.map((column) => column.name)),
    )
  }
  return rowsMatchUnordered(
    projectedRows(before, after.columns.map((column) => column.name)),
    after.rows,
  )
}

function alterActionText(statement: Extract<SupportedDdl, { operation: 'ALTER_TABLE' }>): string {
  switch (statement.action.kind) {
    case 'RENAME_TABLE': return `RENAME TABLE ${statement.table} TO ${statement.action.newTable}`
    case 'RENAME_COLUMN': return `RENAME COLUMN ${statement.action.oldColumn} TO ${statement.action.newColumn}`
    case 'ADD_COLUMN': return `ADD COLUMN ${statement.action.column}`
    case 'DROP_COLUMN': return `DROP COLUMN ${statement.action.column}`
  }
}

function buildAlterTable(
  statement: Extract<SupportedDdl, { operation: 'ALTER_TABLE' }>,
  before: DdlSchemaState,
  after: DdlSchemaState,
): BuiltPreview {
  if (before.table === null || after.table === null) {
    throw new PreviewReject(`ALTER TABLE did not produce the expected before/after table metadata for "${statement.table}".`)
  }
  if (!alterPreservesRows(statement, before.table, after.table)) {
    throw new PreviewReject('The isolated ALTER TABLE changed or lost existing row data, so the preview was discarded.')
  }
  const action = alterActionText(statement)
  const snapshots = [
    snapshot('ORIGINAL_SCHEMA', `Original columns · ${before.table.name}`, COLUMN_COLUMNS,
      columnValues(before.table), before,
      `PRAGMA table_xinfo captured ${before.table.columns.length} original columns and ${before.table.rowCount} rows.`, 0),
    snapshot('ALTER_OPERATION', action, ['operation', 'target_table', 'statement'],
      [[statement.action.kind, before.table.name, statement.sql]], before,
      `The isolated copy will apply ${action} to "${before.table.name}".`, before.table.columns.length),
    snapshot('SCHEMA_TRANSFORMATION', `Resulting columns · ${after.table.name}`, COLUMN_COLUMNS,
      columnValues(after.table), after,
      `${action} succeeded. SQLite preserved all ${before.table.rowCount} existing rows across the surviving columns.`, 1, 'changed'),
    snapshot('RESULTING_SCHEMA', `Resulting schema · ${after.catalog.length} objects`, CATALOG_COLUMNS,
      catalogValues(after), after,
      `The resulting catalog and "${after.table.name}" definition were read back from SQLite after the ALTER.`, after.table.columns.length),
  ]
  return {
    snapshots,
    ddl: {
      operation: 'ALTER_TABLE', objectType: 'TABLE', objectName: statement.table,
      targetTable: after.table.name, noOp: false, rowDataChanged: false, before, after,
    },
  }
}

function buildDropTable(
  statement: Extract<SupportedDdl, { operation: 'DROP_TABLE' }>,
  before: DdlSchemaState,
  after: DdlSchemaState,
  noOp: boolean,
): BuiltPreview {
  if (!noOp && (before.table === null || after.table !== null)) {
    throw new PreviewReject(`DROP TABLE did not remove the expected table metadata for "${statement.table}".`)
  }
  const name = before.table?.name ?? statement.table
  const explanation = noOp
    ? `IF EXISTS found no table named "${name}", so SQLite made no schema change.`
    : `SQLite removed "${name}" and its dependent catalog entries in the isolated copy.`
  const snapshots = [
    snapshot('ORIGINAL_SCHEMA', `Original table · ${name}`, TABLE_COLUMNS,
      tableValues(before.table), before, noOp
        ? `No table named "${name}" exists in the isolated schema.`
        : `The table currently has ${before.table?.rowCount ?? 0} rows and ${before.table?.columns.length ?? 0} columns.`, 0),
    snapshot('DROP_TABLE', noOp ? 'DROP TABLE · no change' : `DROP TABLE · ${name}`, TABLE_COLUMNS,
      tableValues(after.table), after, explanation, before.table === null ? 0 : 1, 'deleted'),
    snapshot('REMOVED_TABLE', noOp ? 'No table removed' : `Removed table · ${name}`, TABLE_COLUMNS,
      tableValues(before.table), before, noOp
        ? 'There is no removed table to show.'
        : `This is the real pre-drop definition of "${name}", including its row count.`, 0, 'deleted'),
    snapshot('REMAINING_SCHEMA', `Remaining schema · ${after.catalog.length} objects`, CATALOG_COLUMNS,
      catalogValues(after), after, noOp
        ? 'The catalog is unchanged.'
        : `The remaining catalog has ${after.catalog.length} objects; SQLite no longer reports "${name}".`, 0),
  ]
  return {
    snapshots,
    ddl: {
      operation: 'DROP_TABLE', objectType: 'TABLE', objectName: statement.table,
      targetTable: name, noOp, rowDataChanged: !noOp && (before.table?.rowCount ?? 0) > 0,
      before, after,
    },
  }
}

function rejectDropTableSideEffects(
  db: SQLiteDatabase,
  before: DdlSchemaState,
): void {
  if (before.table === null) return
  for (const object of before.catalog) {
    if (object.type !== 'table') continue
    const table = readDdlTable(db, object.name, before.catalog)
    for (const column of table?.columns ?? []) {
      for (const foreignKey of column.foreignKeys) {
        if (foreignKey.targetTable.toLowerCase() !== before.table.name.toLowerCase()) continue
        if (foreignKey.onDelete.toUpperCase() !== 'NO ACTION') {
          throw new PreviewReject(
            `DROP TABLE preview rejects "${object.name}.${column.name}" because its ON DELETE ${foreignKey.onDelete} action could change rows outside the target table.`,
          )
        }
      }
    }
  }
}

function indexValues(index: DdlIndexState | null): unknown[][] {
  return index === null ? [] : [[
    index.name, index.tableName, index.unique, index.origin,
    index.columns.map((column) => column ?? '<expression>').join(', '), index.sql,
  ]]
}

function assertIndexRowsPreserved(before: DdlSchemaState, after: DdlSchemaState): void {
  if (before.table !== null && after.table !== null && !rowsMatchUnordered(before.table.rows, after.table.rows)) {
    throw new PreviewReject('The isolated index operation changed table rows, so the preview was discarded.')
  }
}

function buildCreateIndex(
  statement: Extract<SupportedDdl, { operation: 'CREATE_INDEX' }>,
  before: DdlSchemaState,
  after: DdlSchemaState,
  noOp: boolean,
): BuiltPreview {
  if (before.table === null || after.table === null || after.index === null) {
    throw new PreviewReject(`CREATE INDEX did not produce the expected index metadata for "${statement.index}".`)
  }
  assertIndexRowsPreserved(before, after)
  const index = after.index
  const explanation = noOp
    ? `IF NOT EXISTS found existing index "${index.name}", so SQLite made no schema change.`
    : `SQLite created "${index.name}" on "${index.tableName}" in the isolated copy.`
  const snapshots = [
    snapshot('DATABASE', `Database schema before · ${before.catalog.length} objects`, CATALOG_COLUMNS,
      catalogValues(before), before, `The isolated copy starts with ${before.catalog.length} catalog objects.`, 0),
    snapshot('INDEX_DEFINITION', `Index definition · ${index.name}`, INDEX_COLUMNS,
      indexValues(index), after, noOp
        ? `The existing index definition was retained; the new definition was not applied.`
        : `The index definition is ${statement.sql}`, before.catalog.length),
    snapshot('CREATE_INDEX', noOp ? 'CREATE INDEX · no change' : `CREATE INDEX · ${index.name}`, INDEX_COLUMNS,
      indexValues(index), after, `${explanation} Table rows are unchanged.`, 1, noOp ? 'unchanged' : 'inserted'),
    snapshot('INDEX_METADATA', `Index metadata · ${index.columns.length} keys`, INDEX_COLUMNS,
      indexValues(index), after,
      `PRAGMA index_list and index_xinfo report ${index.unique ? 'a unique' : 'a non-unique'} ${index.origin} index with ${index.columns.length} key${index.columns.length === 1 ? '' : 's'}.`, 1),
  ]
  return {
    snapshots,
    ddl: {
      operation: 'CREATE_INDEX', objectType: 'INDEX', objectName: statement.index,
      targetTable: index.tableName, noOp, rowDataChanged: false, before, after,
    },
  }
}

function buildDropIndex(
  statement: Extract<SupportedDdl, { operation: 'DROP_INDEX' }>,
  before: DdlSchemaState,
  after: DdlSchemaState,
  noOp: boolean,
): BuiltPreview {
  if (!noOp && (before.table === null || before.index === null || after.table === null || after.index !== null)) {
    throw new PreviewReject(`DROP INDEX did not remove the expected index metadata for "${statement.index}".`)
  }
  assertIndexRowsPreserved(before, after)
  const name = before.index?.name ?? statement.index
  const snapshots = [
    snapshot('EXISTING_INDEX', noOp ? `Missing index · ${name}` : `Existing index · ${name}`, INDEX_COLUMNS,
      indexValues(before.index), before, noOp
        ? `No index named "${name}" exists; IF EXISTS makes this statement a no-op.`
        : `SQLite reports this existing ${before.index?.origin ?? ''} index before the drop.`, 0),
    snapshot('DROP_INDEX', noOp ? 'DROP INDEX · no change' : `DROP INDEX · ${name}`, INDEX_COLUMNS,
      indexValues(after.index), after, noOp
        ? 'The schema and table rows are unchanged.'
        : `SQLite removed "${name}" from the isolated schema; table rows are unchanged.`, before.index === null ? 0 : 1, 'deleted'),
    snapshot('REMAINING_INDEXES', `Remaining indexes · ${after.table?.indexes.length ?? 0}`, INDEX_COLUMNS,
      after.table?.indexes.flatMap((index) => indexValues(index)) ?? [], after,
      noOp
        ? 'No index was removed.'
        : `The owning table "${after.table?.name ?? before.table?.name ?? ''}" retains ${after.table?.indexes.length ?? 0} indexes.`, 0),
  ]
  return {
    snapshots,
    ddl: {
      operation: 'DROP_INDEX', objectType: 'INDEX', objectName: statement.index,
      targetTable: before.table?.name ?? after.table?.name ?? null,
      noOp, rowDataChanged: false, before, after,
    },
  }
}

function isNoOp(statement: SupportedDdl, before: DdlSchemaState): boolean {
  if (statement.operation === 'CREATE_TABLE') return statement.ifNotExists && before.table !== null
  if (statement.operation === 'CREATE_INDEX') return statement.ifNotExists && before.index !== null
  if (statement.operation === 'DROP_TABLE') return statement.ifExists && before.table === null
  if (statement.operation === 'DROP_INDEX') return statement.ifExists && before.index === null
  return false
}

function buildPreview(
  statement: SupportedDdl,
  before: DdlSchemaState,
  after: DdlSchemaState,
  noOp: boolean,
): BuiltPreview {
  if (statement.operation === 'CREATE_TABLE') return buildCreateTable(statement, before, after, noOp)
  if (statement.operation === 'ALTER_TABLE') return buildAlterTable(statement, before, after)
  if (statement.operation === 'DROP_TABLE') return buildDropTable(statement, before, after, noOp)
  if (statement.operation === 'CREATE_INDEX') return buildCreateIndex(statement, before, after, noOp)
  if (statement.operation === 'DROP_INDEX') return buildDropIndex(statement, before, after, noOp)
  throw new PreviewReject('Unsupported DDL preview operation.')
}

/** Execute one supported DDL statement on a clone and return its real schema trace. */
export function previewDdl(
  sql: string,
  statements: string[],
  activeDb: SQLiteDatabase,
): DdlPreviewOutcome {
  const interpretation = interpretDdl(statements)
  if (!interpretation.supported) return failure(interpretation.reasons)
  const statement = interpretation.statement
  let clone: SQLiteDatabase | null = null
  try {
    clone = SQLiteDatabase.createFromSnapshot(activeDb.exportSnapshot())
    const before = beforeSchema(clone, statement)
    if (statement.operation === 'DROP_TABLE') rejectDropTableSideEffects(clone, before)
    clone.executeBatch(statement.sql)
    const after = afterSchema(clone, statement, before)
    const noOp = isNoOp(statement, before)
    const built = buildPreview(statement, before, after, noOp)
    const events = buildEvents(built.snapshots)
    const finalSnapshot = built.snapshots[built.snapshots.length - 1]
    if (finalSnapshot === undefined) throw new PreviewReject('The DDL preview produced no schema snapshots.')
    const statementType = statement.operation === 'ALTER_TABLE'
      ? 'ALTER'
      : statement.operation === 'DROP_TABLE' || statement.operation === 'DROP_INDEX'
        ? 'DROP'
        : 'CREATE'
    const trace: VisualizationTrace = {
      query: sql,
      statementType,
      capability: analyzeDdlCapability(statement),
      rootBlockId: 'q1',
      stages: built.snapshots.map((snap) => snap.stage),
      events,
      stageSnapshots: built.snapshots,
      sourceTables: [],
      ddl: built.ddl,
      totalSteps: events.length,
      finalRows: finalSnapshot.rows,
      finalColumns: finalSnapshot.columns,
      hasDeterministicOrder: true,
      truncated: false,
    }
    return {
      simulation: { ok: true, trace },
      execution: null,
      validation: {
        validated: true,
        method: 'ordered',
        detail: 'SQLite executed the statement on an isolated copy; before/after schema states were read from sqlite_master and PRAGMA introspection.',
        actualColumns: [],
        actualRowCount: 0,
      },
    }
  } catch (error) {
    if (error instanceof PreviewReject) return failure([error.message])
    return failure([`The isolated DDL preview could not run: ${messageOf(error)}`])
  } finally {
    clone?.close()
  }
}
