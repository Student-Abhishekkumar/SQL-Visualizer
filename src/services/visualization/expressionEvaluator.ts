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
 * Compare two non-NULL values using SQLite's type ordering:
 * numbers sort before text; equal types compare numerically/lexically.
 */
export function compareNonNull(a: unknown, b: unknown): number {
  const aIsNumber = typeof a === 'number' || typeof a === 'bigint'
  const bIsNumber = typeof b === 'number' || typeof b === 'bigint'
  if (aIsNumber && bIsNumber) {
    const an = toSqliteNumber(a)
    const bn = toSqliteNumber(b)
    return an < bn ? -1 : an > bn ? 1 : 0
  }
  if (aIsNumber) return -1
  if (bIsNumber) return 1
  const as = String(a)
  const bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
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

function resolveColumn(
  table: string | null,
  name: string,
  text: string,
  ctx: RowContext,
): unknown {
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
  return ctx.values[matchIndex]
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

/** Evaluate one scalar comparison against pre-resolved values. */
function compareVerdict(
  operator: ComparisonExpr['operator'],
  left: unknown,
  right: unknown,
): EvalVerdict {
  switch (operator) {
    case '=':
    case '!=':
    case '<>':
    case '>':
    case '<':
    case '>=':
    case '<=': {
      if (left === null || left === undefined || right === null || right === undefined) {
        return 'unknown'
      }
      const order = compareNonNull(left, right)
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
      }
      return result ? 'true' : 'false'
    }
    case 'IS':
    case 'IS NOT': {
      // Null-safe equality: NULL IS NULL → true; NULL IS 5 → false.
      const leftNull = left === null || left === undefined
      const rightNull = right === null || right === undefined
      let equal: boolean
      if (leftNull && rightNull) equal = true
      else if (leftNull !== rightNull) equal = false
      else equal = compareNonNull(left, right) === 0
      if (operator === 'IS NOT') equal = !equal
      return equal ? 'true' : 'false'
    }
    default:
      throw new EvaluationError(`Operator "${operator}" is not a scalar comparison.`)
  }
}

/**
 * Three-valued IN over already-resolved values, matching SQLite:
 * - empty set: IN → false, NOT IN → true
 * - NULL left → UNKNOWN (even for NOT IN)
 * - a match → IN true / NOT IN false
 * - no match but a NULL member → UNKNOWN
 * - otherwise IN false / NOT IN true
 */
function inValuesVerdict(
  left: unknown,
  items: readonly unknown[],
  negated: boolean,
): EvalVerdict {
  if (items.length === 0) return negated ? 'true' : 'false'
  if (left === null || left === undefined) return 'unknown'
  let sawNull = false
  for (const itemValue of items) {
    if (itemValue === null || itemValue === undefined) {
      sawNull = true
      continue
    }
    if (compareNonNull(left, itemValue) === 0) {
      return negated ? 'false' : 'true'
    }
  }
  if (sawNull) return 'unknown'
  return negated ? 'true' : 'false'
}

function inVerdict(left: unknown, list: ListExpr, negated: boolean, ctx: RowContext): EvalVerdict {
  return inValuesVerdict(
    left,
    list.exprs.map((item) => evaluateExpression(item, ctx)),
    negated,
  )
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
  left: unknown,
  low: unknown,
  high: unknown,
  negated: boolean,
): EvalVerdict {
  const geLow = compareVerdict('>=', left, low)
  const leHigh = compareVerdict('<=', left, high)
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
      const verdict = inValuesVerdict(
        evaluateExpression(expr.left, ctx),
        values,
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
        const verdict = inVerdict(evaluateExpression(expr.left, ctx), expr.right, op === 'NOT IN', ctx)
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
        const low = evaluateExpression(expr.right.exprs[0] as Expression, ctx)
        const high = evaluateExpression(expr.right.exprs[1] as Expression, ctx)
        const verdict = betweenVerdict(
          evaluateExpression(expr.left, ctx),
          low,
          high,
          op === 'NOT BETWEEN',
        )
        return verdict === 'unknown' ? null : verdict === 'true'
      }
      const verdict = compareVerdict(
        op,
        evaluateExpression(expr.left, ctx),
        evaluateExpression(expr.right, ctx),
      )
      return verdict === 'unknown' ? null : verdict === 'true'
    }
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

function distinctValues(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  const unique: unknown[] = []
  for (const value of values) {
    const key = `${typeof value}:${String(value)}`
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
  const considered = call.distinct ? distinctValues(values) : values
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
        if (compareNonNull(value, min) < 0) min = value
      }
      return min
    }
    case 'MAX': {
      if (considered.length === 0) return null
      let max = considered[0] as unknown
      for (const value of considered) {
        if (compareNonNull(value, max) > 0) max = value
      }
      return max
    }
  }
}
