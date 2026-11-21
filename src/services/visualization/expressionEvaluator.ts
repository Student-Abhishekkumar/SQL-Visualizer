/**
 * Expression evaluator (Stage 2, Milestone 2.3 prep).
 *
 * Evaluates the typed expression tree produced by the AST interpreter
 * against a row context, following SQLite semantics — most importantly
 * three-valued logic (TRUE / FALSE / UNKNOWN where UNKNOWN = NULL).
 *
 * Semantics implemented (matching SQLite):
 * - NULL propagates through arithmetic and comparisons; `NOT unknown` is
 *   still unknown; AND/OR follow 3VL truth tables.
 * - `x IN (list)`: NULL on the left yields UNKNOWN; a NULL list member
 *   turns "no match" into UNKNOWN.
 * - `BETWEEN` is `x >= lo AND x <= hi` with 3VL combination.
 * - `IS` / `IS NOT` are null-safe equality.
 * - LIKE is case-insensitive (SQLite folds ASCII letters only; the
 *   regex used here folds more — documented limitation).
 * - Arithmetic coerces text to numbers via the leading numeric prefix
 *   (else 0), integer / integer performs integer division, and division
 *   or modulo by zero yields NULL.
 * - Aggregates (COUNT/SUM/AVG/MIN/MAX) ignore NULLs; COUNT(*) counts
 *   every row; aggregates over an empty value set yield NULL except
 *   COUNT, which yields 0.
 */

import type {
  AggregateCall,
  ComparisonExpr,
  Expression,
  ListExpr,
} from './astInterpreter'
import { rowKey } from './rowIdentity'
import {
  applyNumericAffinity,
  applyTextAffinity,
  compareValues,
  normalizeKeyValue,
  type CollationName,
  type ColumnMeta,
} from './sqliteAffinity'

/** Three-valued verdict of a condition evaluation. */
export type EvalVerdict = 'true' | 'false' | 'unknown'

/** Thrown when an expression cannot be evaluated in the given context. */
export class EvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvaluationError'
  }
}

/** Everything needed to resolve column references for one row. */
export interface RowContext {
  /**
   * Column labels visible to the row. Entries may be qualified
   * (`"e.salary"`) or bare (`"salary"`). Matching is case-insensitive.
   */
  columns: string[]
  /** Value per column, aligned with `columns`. */
  values: unknown[]
  /**
   * Pre-computed aggregate results keyed by aggregate expression text
   * (e.g. `"AVG(salary)"`). Required when the expression contains
   * aggregates — per-row evaluation of an aggregate is an error.
   */
  aggregates?: Record<string, unknown>
  /**
   * Values of nested query blocks keyed by SubqueryExpr.id. The simulator
   * evaluates each block once against real data and supplies the result
   * here, so expression evaluation never re-executes SQL.
   */
  subqueryValues?: ReadonlyMap<string, unknown>
  /**
   * Metadata aligned with `columns`: declared affinity and collation for
   * each visible column. Absent/falsy entries mean "no reliably inferable
   * affinity" and BINARY collation (the historical behaviour).
   */
  columnMeta?: ReadonlyArray<ColumnMeta | null | undefined>
  /** Output metadata of nested blocks keyed by SubqueryExpr.id. */
  subqueryColumnMeta?: ReadonlyMap<string, ColumnMeta>
}

// ---------------------------------------------------------------------------
// Value helpers (SQLite semantics)
// ---------------------------------------------------------------------------

const NUMERIC_PREFIX = /^[ \t\n]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/

/** Coerce a value to a number the way SQLite does (text → prefix, else 0). */
export function toSqliteNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isNaN(value) ? 0 : value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const match = NUMERIC_PREFIX.exec(value)
    if (match === null) return 0
    return Number.parseFloat(match[0] as string)
  }
  return 0
}

/** Is the value an integral number (SQLite INTEGER affinity)? */
function isIntegerValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Compare two non-NULL values using SQLite's storage-class ordering
 * (numbers < text < blobs) with BINARY collation.
 */
export function compareNonNull(a: unknown, b: unknown): number {
  return compareValues(a, b, 'BINARY')
}

/**
 * Convert a LIKE pattern (% / _) into an anchored case-insensitive
 * regex. Limitation: SQLite folds only ASCII letters; the `i` flag also
 * folds non-ASCII letters.
 */
export function likeToRegex(pattern: string): RegExp {
  let body = ''
  for (const ch of pattern) {
    if (ch === '%') body += '[\\s\\S]*'
    else if (ch === '_') body += '[\\s\\S]'
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${body}$`, 'i')
}

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

function splitLabel(label: string): { table: string | null; name: string } {
  const dot = label.indexOf('.')
  if (dot >= 0) {
    return { table: label.slice(0, dot), name: label.slice(dot + 1) }
  }
  return { table: null, name: label }
}

/** Resolve a column reference to its index in the row context. */
function resolveColumnIndex(
  table: string | null,
  name: string,
  text: string,
  ctx: RowContext,
): number {
  const wantedName = name.toLowerCase()
  const wantedTable = table === null ? null : table.toLowerCase()
  let matchIndex = -1
  let ambiguous = false
  for (let i = 0; i < ctx.columns.length; i++) {
    const label = ctx.columns[i] ?? ''
    const { table: labelTable, name: labelName } = splitLabel(label)
    if (labelName.toLowerCase() !== wantedName) continue
    if (wantedTable !== null && (labelTable ?? '').toLowerCase() !== wantedTable) continue
    if (matchIndex === -1) matchIndex = i
    else ambiguous = true
  }
  if (matchIndex === -1) {
    throw new EvaluationError(`Unknown column "${text}" in the current row context.`)
  }
  if (ambiguous && wantedTable === null) {
    throw new EvaluationError(
      `Column "${name}" is ambiguous — qualify it with a table name or alias.`,
    )
  }
  return matchIndex
}

function resolveColumn(
  table: string | null,
  name: string,
  text: string,
  ctx: RowContext,
): unknown {
  return ctx.values[resolveColumnIndex(table, name, text, ctx)]
}

/** Metadata of a column reference, or null when unknown/not a column. */
function columnMetaOf(expr: Expression, ctx: RowContext): ColumnMeta | null {
  if (expr.kind === 'subquery') return ctx.subqueryColumnMeta?.get(expr.id) ?? null
  if (expr.kind !== 'column') return null
  try {
    const index = resolveColumnIndex(expr.table, expr.name, expr.text, ctx)
    return ctx.columnMeta?.[index] ?? null
  } catch {
    // The value evaluation reports the real unknown/ambiguous-column
    // error; metadata must never mask it with a second failure.
    return null
  }
}

/**
 * SQLite affinity of an expression: a column's declared affinity, the
 * operand's affinity for `COLLATE`, a subquery's output affinity, and
 * "none" for computed expressions and literals.
 */
export function affinityOfExpression(expr: Expression, ctx: RowContext): ColumnMeta['affinity'] {
  if (expr.kind === 'collate') return affinityOfExpression(expr.operand, ctx)
  return columnMetaOf(expr, ctx)?.affinity ?? null
}

/** Collation explicitly written with COLLATE, or null. */
export function explicitCollationOf(expr: Expression): CollationName | null {
  return expr.kind === 'collate' ? expr.collation : null
}

function assertSupportedCollation(meta: ColumnMeta): void {
  if (meta.unsupportedCollation !== undefined) {
    throw new EvaluationError(
      `Column collation "${meta.unsupportedCollation}" is not reproducible by the visualizer; only BINARY and NOCASE are supported.`,
    )
  }
}

/** Column-declared collation that participates in an expression, or null. */
function declaredCollationOf(expr: Expression, ctx: RowContext): CollationName | null {
  const meta = columnMetaOf(expr, ctx)
  if (meta === null) return null
  assertSupportedCollation(meta)
  return meta.collation
}

/**
 * Collation SQLite uses for a comparison: explicit left, explicit right,
 * left column declaration, right column declaration, else BINARY.
 */
export function comparisonCollation(
  left: Expression,
  right: Expression,
  ctx: RowContext,
): CollationName {
  return (
    explicitCollationOf(left) ??
    explicitCollationOf(right) ??
    declaredCollationOf(left, ctx) ??
    declaredCollationOf(right, ctx) ??
    'BINARY'
  )
}

/** Collation an expression carries on its own (for ORDER/GROUP/DISTINCT). */
export function collationOfExpression(expr: Expression, ctx: RowContext): CollationName {
  return explicitCollationOf(expr) ?? declaredCollationOf(expr, ctx) ?? 'BINARY'
}

/**
 * Metadata of a projected output column. Columns propagate their source
 * metadata; `COLLATE` overrides only the collation; every other computed
 * expression honestly reports no affinity.
 */
export function metadataOfExpression(expr: Expression, ctx: RowContext): ColumnMeta {
  if (expr.kind === 'collate') {
    const meta = { ...metadataOfExpression(expr.operand, ctx) }
    // An explicit supported collation replaces the declaration completely.
    delete meta.unsupportedCollation
    return { ...meta, collation: expr.collation }
  }
  const meta = columnMetaOf(expr, ctx)
  if (meta !== null) return { ...meta }
  return { affinity: null, collation: 'BINARY' }
}

/** One comparison operand: value plus the semantics SQLite applies. */
interface ComparisonOperand {
  value: unknown
  affinity: ColumnMeta['affinity']
  /** COLLATE written directly on this operand. */
  explicitCollation: CollationName | null
  /** Column/subquery-declared collation of this operand. */
  declaredCollation: CollationName | null
  numberKind?: 'integer' | 'real'
}

function operandOf(expr: Expression, ctx: RowContext): ComparisonOperand {
  const value = evaluateExpression(expr, ctx)
  const meta = columnMetaOf(expr, ctx)
  if (meta !== null) assertSupportedCollation(meta)
  return {
    value,
    affinity: affinityOfExpression(expr, ctx),
    explicitCollation: explicitCollationOf(expr),
    declaredCollation: meta?.collation ?? null,
    numberKind:
      expr.kind === 'literal' ? expr.numberKind : undefined,
  }
}

function isNumericAffinity(affinity: ColumnMeta['affinity']): boolean {
  return affinity === 'INTEGER' || affinity === 'REAL' || affinity === 'NUMERIC'
}

/**
 * Compare two operands with SQLite comparison-affinity rules. If exactly
 * one side carries a numeric affinity and the other has TEXT/BLOB/no
 * affinity, NUMERIC affinity is applied to the other side. If one side is
 * TEXT and the other has no affinity, TEXT affinity is applied. When both
 * operands have affinity, no conversion happens.
 */
function compareOperands(left: ComparisonOperand, right: ComparisonOperand): number {
  let leftValue = left.value
  let rightValue = right.value
  const leftAffinity = left.affinity
  const rightAffinity = right.affinity

  if (
    isNumericAffinity(leftAffinity) &&
    (rightAffinity === null || rightAffinity === 'TEXT' || rightAffinity === 'BLOB')
  ) {
    rightValue = applyNumericAffinity(rightValue, right.numberKind)
  } else if (
    isNumericAffinity(rightAffinity) &&
    (leftAffinity === null || leftAffinity === 'TEXT' || leftAffinity === 'BLOB')
  ) {
    leftValue = applyNumericAffinity(leftValue, left.numberKind)
  } else if (leftAffinity === 'TEXT' && rightAffinity === null) {
    rightValue = applyTextAffinity(rightValue, right.numberKind)
  } else if (rightAffinity === 'TEXT' && leftAffinity === null) {
    leftValue = applyTextAffinity(leftValue, left.numberKind)
  }

  const collation =
    left.explicitCollation ??
    right.explicitCollation ??
    left.declaredCollation ??
    right.declaredCollation ??
    'BINARY'
  return compareValues(leftValue, rightValue, collation)
}

// ---------------------------------------------------------------------------
// 3VL condition evaluation
// ---------------------------------------------------------------------------

function verdictOf(value: unknown): EvalVerdict {
  if (value === null || value === undefined) return 'unknown'
  if (typeof value === 'number') return value !== 0 ? 'true' : 'false'
  if (typeof value === 'string') return toSqliteNumber(value) !== 0 ? 'true' : 'false'
  return value ? 'true' : 'false'
}

function notVerdict(verdict: EvalVerdict): EvalVerdict {
  if (verdict === 'true') return 'false'
  if (verdict === 'false') return 'true'
  return 'unknown'
}

function andVerdicts(a: EvalVerdict, b: EvalVerdict): EvalVerdict {
  if (a === 'false' || b === 'false') return 'false'
  if (a === 'unknown' || b === 'unknown') return 'unknown'
  return 'true'
}

/** Turn an ordering result into the operator's three-valued verdict. */
function verdictFromOrder(operator: ComparisonExpr['operator'], order: number): EvalVerdict {
  let result: boolean
  switch (operator) {
    case '=':
      result = order === 0
      break
    case '!=':
    case '<>':
      result = order !== 0
      break
    case '>':
      result = order > 0
      break
    case '<':
      result = order < 0
      break
    case '>=':
      result = order >= 0
      break
    case '<=':
      result = order <= 0
      break
    default:
      throw new EvaluationError(`Operator "${operator}" is not a scalar comparison.`)
  }
  return result ? 'true' : 'false'
}

/** Evaluate one scalar comparison with SQLite affinity and collation. */
function compareVerdict(
  operator: ComparisonExpr['operator'],
  left: ComparisonOperand,
  right: ComparisonOperand,
): EvalVerdict {
  if (operator === 'IS' || operator === 'IS NOT') {
    // Null-safe equality: NULL IS NULL → true; NULL IS 5 → false. The
    // same affinity and collation rules as `=` apply to non-NULL values.
    const leftNull = left.value === null || left.value === undefined
    const rightNull = right.value === null || right.value === undefined
    let equal: boolean
    if (leftNull && rightNull) equal = true
    else if (leftNull !== rightNull) equal = false
    else equal = compareOperands(left, right) === 0
    if (operator === 'IS NOT') equal = !equal
    return equal ? 'true' : 'false'
  }

  if (
    left.value === null ||
    left.value === undefined ||
    right.value === null ||
    right.value === undefined
  ) {
    return 'unknown'
  }
  return verdictFromOrder(operator, compareOperands(left, right))
}

/**
 * Three-valued IN, comparing the left operand against every list member
 * with SQLite's pairwise affinity/collation rules:
 * - empty set: IN → false, NOT IN → true
 * - NULL left → UNKNOWN (even for NOT IN)
 * - a match → IN true / NOT IN false
 * - no match but a NULL member → UNKNOWN
 * - otherwise IN false / NOT IN true
 */
function inOperandsVerdict(
  left: ComparisonOperand,
  items: readonly ComparisonOperand[],
  negated: boolean,
): EvalVerdict {
  if (items.length === 0) return negated ? 'true' : 'false'
  if (left.value === null || left.value === undefined) return 'unknown'
  let sawNull = false
  for (const item of items) {
    if (item.value === null || item.value === undefined) {
      sawNull = true
      continue
    }
    if (compareOperands(left, item) === 0) {
      return negated ? 'false' : 'true'
    }
  }
  if (sawNull) return 'unknown'
  return negated ? 'true' : 'false'
}

function inVerdict(
  leftExpr: Expression,
  list: ListExpr,
  negated: boolean,
  ctx: RowContext,
): EvalVerdict {
  return inOperandsVerdict(
    operandOf(leftExpr, ctx),
    list.exprs.map((item) => operandOf(item, ctx)),
    negated,
  )
}

/** Build operands for values returned by an IN subquery's single column. */
function subqueryOperands(
  values: readonly unknown[],
  meta: ColumnMeta | undefined,
): ComparisonOperand[] {
  return values.map((value) => ({
    value,
    affinity: meta?.affinity ?? null,
    explicitCollation: null,
    declaredCollation: meta?.collation ?? null,
  }))
}

function likeVerdict(left: unknown, pattern: unknown, negated: boolean): EvalVerdict {
  if (left === null || left === undefined || pattern === null || pattern === undefined) {
    return 'unknown'
  }
  const regex = likeToRegex(String(pattern))
  const matches = regex.test(String(left))
  return (negated ? !matches : matches) ? 'true' : 'false'
}

function betweenVerdict(
  leftExpr: Expression,
  lowExpr: Expression,
  highExpr: Expression,
  negated: boolean,
  ctx: RowContext,
): EvalVerdict {
  // SQLite BETWEEN is `x >= low AND x <= high`, applying affinity and
  // collation to each pair independently.
  const left = operandOf(leftExpr, ctx)
  const geLow = compareVerdict('>=', left, operandOf(lowExpr, ctx))
  const leHigh = compareVerdict('<=', left, operandOf(highExpr, ctx))
  const inside = andVerdicts(geLow, leHigh)
  return negated ? notVerdict(inside) : inside
}

// ---------------------------------------------------------------------------
// Main expression evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an expression to its SQLite value. Returns `null` for SQL
 * NULL. Throws `EvaluationError` when the expression cannot be
 * evaluated in this context (unknown column, per-row aggregate, …).
 */
export function evaluateExpression(expr: Expression, ctx: RowContext): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value === undefined ? null : expr.value
    case 'column':
      return resolveColumn(expr.table, expr.name, expr.text, ctx)
    case 'star':
      throw new EvaluationError('A "*" wildcard has no single value to evaluate.')
    case 'aggregate': {
      const precomputed = ctx.aggregates?.[expr.text]
      if (precomputed === undefined && !(expr.text in (ctx.aggregates ?? {}))) {
        throw new EvaluationError(
          `Aggregate ${expr.text} cannot be evaluated per-row — it is computed per group.`,
        )
      }
      return precomputed ?? null
    }
    case 'list':
      // A bare parenthesized list has no scalar value outside IN/BETWEEN.
      throw new EvaluationError('A value list can only be evaluated as part of IN or BETWEEN.')
    case 'subquery': {
      const values = ctx.subqueryValues
      if (values === undefined || !values.has(expr.id)) {
        throw new EvaluationError(
          `Subquery ${expr.text} has not been evaluated in this context.`,
        )
      }
      return values.get(expr.id)
    }
    case 'in_subquery': {
      const values = ctx.subqueryValues?.get(expr.subquery.id)
      if (!Array.isArray(values)) {
        throw new EvaluationError(
          `Subquery ${expr.subquery.text} has not been evaluated in this context.`,
        )
      }
      const verdict = inOperandsVerdict(
        operandOf(expr.left, ctx),
        subqueryOperands(values, ctx.subqueryColumnMeta?.get(expr.subquery.id)),
        expr.operator === 'NOT IN',
      )
      return verdict === 'unknown' ? null : verdict === 'true'
    }
    case 'exists_subquery': {
      // EXISTS is never UNKNOWN: it is true or false for every row.
      const exists = ctx.subqueryValues?.get(expr.subquery.id)
      if (typeof exists !== 'boolean') {
        throw new EvaluationError(
          `Subquery ${expr.subquery.text} has not been evaluated in this context.`,
        )
      }
      return expr.negated ? !exists : exists
    }
    case 'not': {
      const verdict = notVerdict(evaluateCondition(expr.operand, ctx))
      return verdict === 'unknown' ? null : verdict === 'true'
    }
    case 'logical': {
      if (expr.operator === 'AND') {
        const left = evaluateCondition(expr.left, ctx)
        if (left === 'false') return false
        const right = evaluateCondition(expr.right, ctx)
        const combined = andVerdicts(left, right)
        return combined === 'unknown' ? null : combined === 'true'
      }
      // OR
      const left = evaluateCondition(expr.left, ctx)
      if (left === 'true') return true
      const right = evaluateCondition(expr.right, ctx)
      const combined =
        right === 'true'
          ? 'true'
          : left === 'unknown' || right === 'unknown'
            ? 'unknown'
            : 'false'
      return combined === 'unknown' ? null : combined === 'true'
    }
    case 'comparison': {
      const op = expr.operator
      if (op === 'IN' || op === 'NOT IN') {
        if (expr.right.kind !== 'list') {
          throw new EvaluationError('IN requires a parenthesized value list.')
        }
        const verdict = inVerdict(expr.left, expr.right, op === 'NOT IN', ctx)
        return verdict === 'unknown' ? null : verdict === 'true'
      }
      if (op === 'LIKE' || op === 'NOT LIKE') {
        const verdict = likeVerdict(
          evaluateExpression(expr.left, ctx),
          evaluateExpression(expr.right, ctx),
          op === 'NOT LIKE',
        )
        return verdict === 'unknown' ? null : verdict === 'true'
      }
      if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
        if (expr.right.kind !== 'list' || expr.right.exprs.length !== 2) {
          throw new EvaluationError('BETWEEN requires exactly two bounds.')
        }
        const low = expr.right.exprs[0] as Expression
        const high = expr.right.exprs[1] as Expression
        const verdict = betweenVerdict(
          expr.left,
          low,
          high,
          op === 'NOT BETWEEN',
          ctx,
        )
        return verdict === 'unknown' ? null : verdict === 'true'
      }
      const verdict = compareVerdict(
        op,
        operandOf(expr.left, ctx),
        operandOf(expr.right, ctx),
      )
      return verdict === 'unknown' ? null : verdict === 'true'
    }
    case 'collate':
      // COLLATE changes comparison/collation semantics, never the value.
      return evaluateExpression(expr.operand, ctx)
    case 'arithmetic': {
      const left = evaluateExpression(expr.left, ctx)
      const right = evaluateExpression(expr.right, ctx)
      if (left === null || right === null) return null
      const a = toSqliteNumber(left)
      const b = toSqliteNumber(right)
      switch (expr.operator) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/': {
          if (b === 0) return null
          // SQLite: integer / integer is integer division.
          if (isIntegerValue(left) && isIntegerValue(right)) return Math.trunc(a / b)
          return a / b
        }
        case '%': {
          if (b === 0) return null
          return a % b
        }
      }
      break
    }
    case 'unary_minus': {
      const value = evaluateExpression(expr.operand, ctx)
      if (value === null) return null
      return -toSqliteNumber(value)
    }
  }
}

/**
 * Evaluate a condition and return its three-valued verdict. Unlike
 * `evaluateExpression`, never coerces UNKNOWN away — the simulator uses
 * this to explain rows whose condition evaluates to UNKNOWN (treated as
 * filtered out, exactly like SQLite).
 */
export function evaluateCondition(expr: Expression, ctx: RowContext): EvalVerdict {
  return verdictOf(evaluateExpression(expr, ctx))
}

// ---------------------------------------------------------------------------
// Aggregate evaluation (per group)
// ---------------------------------------------------------------------------

function distinctValues(values: unknown[], collation: CollationName): unknown[] {
  const seen = new Set<string>()
  const unique: unknown[] = []
  for (const value of values) {
    const key = rowKey([normalizeKeyValue(value, collation)])
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(value)
  }
  return unique
}

/**
 * Evaluate an aggregate call over the rows of one group. Rows are
 * `{ columns, values }` contexts; the aggregate argument is evaluated
 * per row with SQLite NULL semantics.
 */
export function evaluateAggregate(
  call: AggregateCall,
  rows: RowContext[],
): unknown {
  if (call.name === 'COUNT' && call.argument === null) {
    return rows.length // COUNT(*)
  }
  if (call.argument === null) {
    throw new EvaluationError(`${call.name}(*) is not a valid aggregate call.`)
  }
  const values: unknown[] = []
  for (const row of rows) {
    const value = evaluateExpression(call.argument, row)
    if (value !== null && value !== undefined) values.push(value)
  }
  const collation =
    (call.distinct || call.name === 'MIN' || call.name === 'MAX') && rows.length > 0
      ? collationOfExpression(call.argument, rows[0] as RowContext)
      : 'BINARY'
  const considered = call.distinct ? distinctValues(values, collation) : values
  switch (call.name) {
    case 'COUNT':
      return considered.length
    case 'SUM': {
      if (considered.length === 0) return null
      return considered.reduce<number>((sum, value) => sum + toSqliteNumber(value), 0)
    }
    case 'AVG': {
      if (considered.length === 0) return null
      const sum = considered.reduce<number>((acc, value) => acc + toSqliteNumber(value), 0)
      return sum / considered.length
    }
    case 'MIN': {
      if (considered.length === 0) return null
      let min = considered[0] as unknown
      for (const value of considered) {
        if (compareValues(value, min, collation) < 0) min = value
      }
      return min
    }
    case 'MAX': {
      if (considered.length === 0) return null
      let max = considered[0] as unknown
      for (const value of considered) {
        if (compareValues(value, max, collation) > 0) max = value
      }
      return max
    }
  }
}
