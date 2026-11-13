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
import type { VisualizedRow, ValidationResult } from '../../types/visualization'
import { interpretQuery } from './astInterpreter'
import { simulateQuery, type SimulationOptions, type SimulationOutcome, type TableData } from './simulator'

const RELATIVE_EPSILON = 1e-9

/** SQL NULL-safe, type-aware value equality. */
export function simulationValuesEqual(a: unknown, b: unknown): boolean {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull || bNull) return aNull && bNull
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    const scale = Math.max(1, Math.abs(a), Math.abs(b))
    return Math.abs(a - b) <= RELATIVE_EPSILON * scale
  }
  return String(a) === String(b)
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

/** Canonical, stable key for one row's values (multiset comparison). */
function rowKey(values: unknown[]): string {
  return `[${values
    .map((value) => {
      if (value === null || value === undefined) return 'null'
      if (typeof value === 'number') {
        // Quantize to 12 significant digits so equivalent floats from
        // different summation orders hash to the same key.
        return `n:${value === 0 ? 0 : Number(value.toPrecision(12))}`
      }
      return `${typeof value}:${String(value)}`
    })
    .join('|')}]`
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
      if (!simulated.every((value, index) => simulationValuesEqual(value, real[index]))) {
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
    // Multiset comparison: SQLite's row order is not guaranteed here.
    const countBy = (rows: unknown[][]) => {
      const counts = new Map<string, number>()
      for (const row of rows) {
        const key = rowKey(row)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return counts
    }
    const simulatedCounts = countBy(simulatedRows)
    const realCounts = countBy(actual.values)
    for (const [key, count] of simulatedCounts) {
      if ((realCounts.get(key) ?? 0) !== count) {
        return {
          validated: false,
          method,
          detail: `Row multiset differs: simulation has ${count} of [${key}] but SQLite's result does not match.`,
          actualColumns: actual.columns,
          actualRowCount: actual.values.length,
        }
      }
    }
    for (const [key, count] of realCounts) {
      if ((simulatedCounts.get(key) ?? 0) !== count) {
        return {
          validated: false,
          method,
          detail: `Row multiset differs: SQLite has ${count} of [${key}] but the simulation does not.`,
          actualColumns: actual.columns,
          actualRowCount: actual.values.length,
        }
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

export interface SimulateAndValidateOutcome {
  simulation: SimulationOutcome
  /** SQLite's real result, when the query executed. */
  execution: { columns: string[]; values: unknown[][] } | null
  validation: ValidationResult | null
}

/**
 * Full pipeline used by the app: simulate the query logically, execute
 * it for real in SQLite, and validate the simulation against reality.
 * A simulation failure never prevents execution and vice versa.
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

  if (simulation.ok && execution !== null) {
    validation = compareSimulationWithSqlite(simulation.trace, execution)
  }

  return { simulation, execution, validation }
}

/** Convert trace rows for consumers that only need plain values. */
export function traceRowsToValues(rows: VisualizedRow[]): unknown[][] {
  return rows.map((row) => row.values)
}
