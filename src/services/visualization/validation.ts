/**
 * SQLite parity validation (Stage 2, Milestone 4).
 *
 * Compares the logical simulator's final result with SQLite's real
 * result for the same query. The real result is NEVER altered to make
 * the comparison succeed — a mismatch is reported honestly with enough
 * detail to debug.
 *
 * Comparison strategy:
 * - `ordered` only when the trace reports a fully determined order
 *   (ORDER BY without ties). Otherwise SQLite does not guarantee row
 *   order, and comparison is `unordered` (multiset equality).
 * - Column labels are compared leniently (case/whitespace-insensitive)
 *   because SQLite reproduces the source spelling of expressions.
 * - Numbers compare with a small relative tolerance (both sides are
 *   IEEE doubles; SUM/AVG must agree), NULLs compare as equal.
 */

import type { SQLiteDatabase } from '../database/sqliteService'
import type {
  NestedBlockValidation,
  NestedQueryTrace,
  ValidationResult,
  VisualizationTrace,
  VisualizedRow,
} from '../../types/visualization'
import { interpretQuery } from './astInterpreter'
import { rowKey, rowsEqual, rowsMatchUnordered, valuesEqual } from './rowIdentity'
import { simulateQuery, type SimulationOptions, type SimulationOutcome, type TableData } from './simulator'

/** SQL NULL-safe, type-aware value equality. */
export function simulationValuesEqual(a: unknown, b: unknown): boolean {
  return valuesEqual(a, b)
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '')
}

/** Minimal result shape the comparator needs from a trace. */
export interface ComparableSimulationResult {
  finalColumns: string[]
  finalRows: VisualizedRow[]
  /** True when ORDER BY fully determines the row order (no ties). */
  hasDeterministicOrder: boolean
}

/**
 * Compare the simulation trace's final result against SQLite's real
 * result. `actual.values` holds positional row values.
 */
export function compareSimulationWithSqlite(
  trace: ComparableSimulationResult,
  actual: { columns: string[]; values: unknown[][] },
): ValidationResult {
  const method: ValidationResult['method'] = trace.hasDeterministicOrder ? 'ordered' : 'unordered'

  // --- columns -------------------------------------------------------------
  if (trace.finalColumns.length !== actual.columns.length) {
    return {
      validated: false,
      method,
      detail: `Column count differs: simulation produced ${trace.finalColumns.length} columns (${trace.finalColumns.join(', ')}), SQLite produced ${actual.columns.length} (${actual.columns.join(', ')}).`,
      actualColumns: actual.columns,
      actualRowCount: actual.values.length,
    }
  }
  for (let i = 0; i < trace.finalColumns.length; i++) {
    const simulated = normalizeLabel(trace.finalColumns[i] ?? '')
    const real = normalizeLabel(actual.columns[i] ?? '')
    if (simulated !== real) {
      return {
        validated: false,
        method,
        detail: `Column name differs at position ${i + 1}: simulation "${trace.finalColumns[i]}", SQLite "${actual.columns[i]}".`,
        actualColumns: actual.columns,
        actualRowCount: actual.values.length,
      }
    }
  }

  // --- rows ------------------------------------------------------------------
  const simulatedRows = trace.finalRows.map((row) => row.values)
  if (simulatedRows.length !== actual.values.length) {
    return {
      validated: false,
      method,
      detail: `Row count differs: simulation produced ${simulatedRows.length}, SQLite produced ${actual.values.length}.`,
      actualColumns: actual.columns,
      actualRowCount: actual.values.length,
    }
  }

  if (method === 'ordered') {
    for (let i = 0; i < simulatedRows.length; i++) {
      const simulated = simulatedRows[i] ?? []
      const real = actual.values[i] ?? []
      if (!rowsEqual(simulated, real)) {
        return {
          validated: false,
          method,
          detail: `Row ${i + 1} differs: simulation [${rowKey(simulated)}], SQLite [${rowKey(real)}].`,
          actualColumns: actual.columns,
          actualRowCount: actual.values.length,
        }
      }
    }
  } else {
    // Multiset comparison uses the same type-aware comparator as ordered
    // validation, including the documented floating-point tolerance.
    if (!rowsMatchUnordered(simulatedRows, actual.values)) {
      return {
        validated: false,
        method,
        detail: 'Row multiset differs: simulation and SQLite produced different rows.',
        actualColumns: actual.columns,
        actualRowCount: actual.values.length,
      }
    }
  }

  return {
    validated: true,
    method,
    actualColumns: actual.columns,
    actualRowCount: actual.values.length,
  }
}

/** Read a table's full contents through the live SQLite connection. */
export function readTableFromDb(db: SQLiteDatabase, name: string): TableData | null {
  try {
    const result = db.queryAll(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
    return { columns: [...result.columns], rows: result.values.map((row) => [...row]) }
  } catch {
    return null
  }
}

/** Quote an identifier for the SQLite standalone-validation wrapper. */
function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/**
 * Build a standalone SQLite statement for a nested block.
 *
 * A block that reads a CTE cannot run in isolation: the CTE definition is
 * not in its own SQL text. Like the CTE path, prerequisite CTE
 * definitions are re-declared first (transitively), so scalar, IN, EXISTS
 * and CTE blocks all compare against the same real SQL they represent.
 */
function blockValidationSql(block: NestedQueryTrace, trace: VisualizationTrace): string | null {
  const blocks = trace.nestedQueries ?? []
  const byId = new Map(blocks.map((candidate) => [candidate.id, candidate]))
  const needed = new Set<string>()
  const visit = (blockId: string): void => {
    if (needed.has(blockId)) return
    const dependency = byId.get(blockId)
    if (dependency === undefined) return
    needed.add(blockId)
    for (const transitive of dependency.dependencies ?? []) visit(transitive.blockId)
  }
  for (const dependency of block.dependencies ?? []) visit(dependency.blockId)

  const definitions: string[] = []
  for (const candidate of blocks) {
    if (candidate.kind !== 'cte' || !needed.has(candidate.id)) continue
    const definition = cteDefinitionSql(candidate)
    if (definition === null) return null
    definitions.push(definition)
  }

  if (block.kind === 'cte') {
    if (block.cteName === undefined || block.cteName === '') return null
    const target = cteDefinitionSql(block)
    if (target === null) return null
    definitions.push(target)
    return `WITH ${definitions.join(', ')} SELECT * FROM ${quoteIdentifier(block.cteName)}`
  }

  if (block.sql.trim() === '') return null
  if (definitions.length === 0) return block.sql
  return `WITH ${definitions.join(', ')} ${block.sql}`
}

function cteDefinitionSql(block: NestedQueryTrace): string | null {
  if (block.cteName === undefined || block.cteName === '' || block.sql.trim() === '') return null
  const columnList =
    block.cteColumns !== null && block.cteColumns !== undefined
      ? `(${block.cteColumns.map(quoteIdentifier).join(', ')})`
      : ''
  return `${quoteIdentifier(block.cteName)}${columnList} AS (${block.sql})`
}

/**
 * Independently validate every nested block the simulator produced.
 *
 * Each block is executed on its own against SQLite. A block that was
 * truncated for display is never reported as validated, and a block
 * SQLite cannot execute in isolation is reported as a limitation (`skipped`)
 * rather than invented. Correlated blocks never reach this point: the
 * simulator aborts before producing a trace.
 */
export function validateNestedBlocks(
  trace: VisualizationTrace,
  db: SQLiteDatabase,
): NestedBlockValidation[] {
  const results: NestedBlockValidation[] = []
  for (const block of trace.nestedQueries ?? []) {
    const method: NestedBlockValidation['method'] = block.hasDeterministicOrder
      ? 'ordered'
      : 'unordered'
    if (block.status === 'unsupported') {
      results.push({
        blockId: block.id,
        label: block.label,
        validated: false,
        method,
        skipped: true,
        detail:
          block.unavailableReasons?.[0] ?? 'This nested block could not be simulated.',
      })
      continue
    }
    if (block.truncated === true) {
      results.push({
        blockId: block.id,
        label: block.label,
        validated: false,
        method,
        skipped: true,
        incomplete: block.incomplete === true,
        detail:
          'The nested block was capped for display, so its parity with SQLite cannot be claimed.',
      })
      continue
    }
    if (block.incomplete === true) {
      const reasons = block.incompleteReasons ?? []
      results.push({
        blockId: block.id,
        label: block.label,
        validated: false,
        method,
        skipped: true,
        incomplete: true,
        detail: `This block read an incomplete intermediate result${
          reasons.length > 0 ? ` (${reasons.join('; ')})` : ''
        }, so its parity with SQLite cannot be claimed.`,
      })
      continue
    }
    if (block.sql.trim() === '') {
      results.push({
        blockId: block.id,
        label: block.label,
        validated: false,
        method,
        skipped: true,
        detail: 'The nested block has no executable SQL text.',
      })
      continue
    }
    // Blocks that read a CTE are validated through a WITH wrapper that
    // redeclares the prerequisite definitions; a plain block keeps its SQL.
    const validationSql = blockValidationSql(block, trace)
    if (validationSql === null) {
      results.push({
        blockId: block.id,
        label: block.label,
        validated: false,
        method,
        skipped: true,
        detail:
          'This block cannot be validated independently because a prerequisite CTE definition is unavailable.',
      })
      continue
    }
    let actual: { columns: string[]; values: unknown[][] }
    try {
      const result = db.queryAll(validationSql)
      actual = { columns: [...result.columns], values: result.values.map((row) => [...row]) }
    } catch (error) {
      results.push({
        blockId: block.id,
        label: block.label,
        validated: false,
        method,
        skipped: true,
        detail: `SQLite could not execute this block in isolation: ${String(error)}`,
      })
      continue
    }
    const comparison = compareSimulationWithSqlite(
      {
        finalColumns: block.finalColumns,
        finalRows: block.finalRows,
        hasDeterministicOrder: block.hasDeterministicOrder === true,
      },
      actual,
    )
    results.push({
      blockId: block.id,
      label: block.label,
      validated: comparison.validated,
      method: comparison.method,
      detail: comparison.detail,
    })
  }
  return results
}

export interface SimulateAndValidateOutcome {
  simulation: SimulationOutcome
  /** SQLite's real result, when the query executed. */
  execution: { columns: string[]; values: unknown[][] } | null
  validation: ValidationResult | null
}

/**
 * Full pipeline used by the app: simulate the query logically, execute
 * it for real in SQLite only after that simulation succeeds, and validate
 * the simulation against reality. Rejected input never reaches execution.
 */
export function simulateAndValidate(
  sql: string,
  statements: string[],
  db: SQLiteDatabase,
  options: SimulationOptions = {},
): SimulateAndValidateOutcome {
  const simulation = (() => {
    const interpretation = interpretQuery(sql, statements)
    if (interpretation.structure === null || interpretation.unsupportedReasons.length > 0) {
      return { ok: false as const, reasons: interpretation.unsupportedReasons.length > 0 ? interpretation.unsupportedReasons : ['The query could not be interpreted.'] }
    }
    return simulateQuery(sql, interpretation.structure, (name) => readTableFromDb(db, name), options)
  })()

  let execution: { columns: string[]; values: unknown[][] } | null = null
  let validation: ValidationResult | null = null

  // Execution is allowed only after a complete, supported read-only
  // simulation succeeds. Rejected input must never reach SQLite through
  // this visualization path.
  if (simulation.ok) {
    try {
      const batch = db.executeBatch(statements.length === 1 ? statements[0] ?? sql : sql)
      const primary = batch.find((result) => result.hasResultSet)
      if (primary !== undefined) {
        execution = { columns: primary.columns, values: primary.values.map((row) => [...row]) }
      }
    } catch {
      // Execution errors are surfaced by the normal execute path, not here.
      execution = null
    }
  }

  if (simulation.ok && execution !== null) {
    validation = compareSimulationWithSqlite(simulation.trace, execution)
    if ((simulation.trace.nestedQueries?.length ?? 0) > 0) {
      validation = { ...validation, nested: validateNestedBlocks(simulation.trace, db) }
    }
    // Parity describes the real SQLite result, but a visualization cap
    // means the simulator never saw the complete relation. A row match
    // must never be reported as validation in that case.
    if (simulation.trace.incomplete === true) {
      const reasons = simulation.trace.incompleteReasons ?? []
      const note = `The visualization is incomplete${
        reasons.length > 0 ? ` (${reasons.join('; ')})` : ''
      }, so the displayed rows are not the complete relation.`
      validation = {
        ...validation,
        validated: false,
        incomplete: true,
        incompleteReasons: reasons,
        detail:
          validation.detail === undefined || validation.detail === ''
            ? `${note} Parity with SQLite cannot be claimed.`
            : `${validation.detail} ${note}`,
      }
    }
  }

  return { simulation, execution, validation }
}

/** Convert trace rows for consumers that only need plain values. */
export function traceRowsToValues(rows: VisualizedRow[]): unknown[][] {
  return rows.map((row) => row.values)
}
