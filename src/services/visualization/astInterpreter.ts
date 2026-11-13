/**
 * AST interpretation layer (Stage 2, Milestone 2.1).
 *
 * Turns the node-sql-parser SQLite AST into a clean, typed query
 * structure that the capability analyzer and the logical simulator can
 * consume. Normalizes parser version quirks (e.g. `column` as string vs
 * `{ expr_value }`), and never throws on unparseable input.
 *
 * Supported expression grammar: comparisons (= != <> > < >= <=), AND /
 * OR / NOT, IN (value lists), BETWEEN, IS NULL / IS NOT NULL, LIKE,
 * arithmetic (+ - * / %), column refs, literals, COUNT/SUM/AVG/MIN/MAX
 * aggregates, and column/star SELECT lists. Anything else is surfaced
 * as an unsupported construct rather than guessed.
 */

import { detectStatementType, parseSql } from '../sql/sqlParser'
import type { StatementType } from '../../types/query'

export type ComparisonOperator =
  | '=' | '!=' | '<>' | '>' | '<' | '>=' | '<='
  | 'IN' | 'NOT IN' | 'BETWEEN' | 'NOT BETWEEN'
  | 'LIKE' | 'NOT LIKE' | 'IS' | 'IS NOT'

export interface ComparisonExpr {
  kind: 'comparison'
  operator: ComparisonOperator
  left: Expression
  right: Expression
  /** Display text of the expression. */
  text: string
}

export interface LogicalExpr {
  kind: 'logical'
  operator: 'AND' | 'OR'
  left: Expression
  right: Expression
  text: string
}

export interface NotExpr {
  kind: 'not'
  operand: Expression
  text: string
}

export interface UnaryMinusExpr {
  kind: 'unary_minus'
  operand: Expression
  text: string
}

export interface ArithmeticExpr {
  kind: 'arithmetic'
  operator: '+' | '-' | '*' | '/' | '%'
  left: Expression
  right: Expression
  text: string
}

export interface LiteralExpr {
  kind: 'literal'
  value: unknown
  text: string
}

export interface ColumnExpr {
  kind: 'column'
  /** Table name or alias as written in the query (null when unqualified). */
  table: string | null
  name: string
  text: string
}

export interface StarExpr {
  kind: 'star'
  table: string | null
  text: string
}

export interface ListExpr {
  kind: 'list'
  /** Interpreted list items (IN / NOT IN / BETWEEN bounds). */
  exprs: Expression[]
  /** Literal values when every item is a literal; null otherwise. */
  values: unknown[] | null
  text: string
}

export type Expression =
  | ComparisonExpr
  | LogicalExpr
  | NotExpr
  | UnaryMinusExpr
  | ArithmeticExpr
  | LiteralExpr
  | ColumnExpr
  | StarExpr
  | ListExpr
  | AggregateExpr

export interface AggregateCall {
  name: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
  /** '*' for COUNT(*). */
  argument: Expression | null
  distinct: boolean
  text: string
}

export interface AggregateExpr {
  kind: 'aggregate'
  call: AggregateCall
  text: string
}

export interface SelectItem {
  expression: Expression
  /** Output column label (alias, or derived from the expression). */
  alias: string | null
  text: string
}

export type JoinType = 'INNER JOIN' | 'LEFT JOIN' | 'CROSS JOIN'

export interface JoinClause {
  type: JoinType
  table: TableRef
  on: Expression | null
  text: string
}

export interface TableRef {
  name: string
  alias: string | null
}

export interface LimitClause {
  limit: number
  offset: number
  text: string
}

export interface OrderByTerm {
  expression: Expression
  direction: 'ASC' | 'DESC'
  text: string
}

/**
 * Clean interpretation of a single SELECT statement. Everything the
 * capability analyzer and the simulator need lives here.
 */
export interface QueryStructure {
  distinct: boolean
  selectItems: SelectItem[]
  selectAll: boolean
  from: TableRef
  joins: JoinClause[]
  where: Expression | null
  groupBy: Expression[]
  having: Expression | null
  orderBy: OrderByTerm[]
  limit: LimitClause | null
  aggregates: AggregateCall[]
  statementType: StatementType
}

export interface InterpretationResult {
  structure: QueryStructure | null
  /** Human-readable reasons the query cannot be interpreted. */
  unsupportedReasons: string[]
}

/** Normalize parser column field across versions: string or {expr_value}. */
function columnNameOf(column: unknown): string {
  if (typeof column === 'string') return column
  if (typeof column === 'object' && column !== null && 'expr_value' in column) {
    const value = (column as { expr_value: unknown }).expr_value
    return typeof value === 'string' ? value : String(value ?? '')
  }
  if (typeof column === 'object' && column !== null && 'name' in column) {
    const value = (column as { name: unknown }).name
    return typeof value === 'string' ? value : String(value ?? '')
  }
  return String(column ?? '')
}

/** Raw JSON AST as produced by node-sql-parser. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any

const COMPARISON_OPERATORS = new Set(['=', '!=', '<>', '>', '<', '>=', '<=', 'IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT'])
const AGGREGATE_NAMES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

/** Convert a raw parser expression into our typed expression tree. */
export function interpretExpression(raw: Raw): Expression | null {
  if (raw == null) return null
  switch (raw.type) {
    case 'column_ref': {
      const table = typeof raw.table === 'string' && raw.table.length > 0 ? raw.table : null
      const name = columnNameOf(raw.column)
      // v5.4 renders `SELECT *` as a column_ref with column '*' (not a star node).
      if (name === '*') {
        return { kind: 'star', table, text: table ? `${table}.*` : '*' }
      }
      return { kind: 'column', table, name, text: table ? `${table}.${name}` : name }
    }
    case 'star': {
      const table = typeof raw.table === 'string' && raw.table.length > 0 ? raw.table : null
      return { kind: 'star', table, text: table ? `${table}.*` : '*' }
    }
    case 'number':
      return { kind: 'literal', value: raw.value, text: String(raw.value) }
    case 'single_quote_string':
      return { kind: 'literal', value: raw.value, text: `'${raw.value}'` }
    case 'double_quote_string':
      return { kind: 'literal', value: raw.value, text: `"${raw.value}"` }
    case 'bool':
      return { kind: 'literal', value: Boolean(raw.value), text: String(raw.value) }
    case 'null':
      return { kind: 'literal', value: null, text: 'NULL' }
    case 'binary_expr': {
      const left = interpretExpression(raw.left)
      const right = interpretExpression(raw.right)
      if (!left || !right) return null
      const op = String(raw.operator).toUpperCase()
      if (op === 'AND' || op === 'OR') {
        return { kind: 'logical', operator: op, left, right, text: `${left.text} ${op} ${right.text}` }
      }
      if (COMPARISON_OPERATORS.has(op)) {
        // BETWEEN/NOT BETWEEN render as `x BETWEEN a AND b`, not with a list.
        let text: string
        if (
          (op === 'BETWEEN' || op === 'NOT BETWEEN') &&
          right.kind === 'list' &&
          right.exprs.length === 2
        ) {
          text = `${left.text} ${op} ${right.exprs[0]?.text} AND ${right.exprs[1]?.text}`
        } else {
          text = `${left.text} ${op} ${right.text}`
        }
        return { kind: 'comparison', operator: op as ComparisonOperator, left, right, text }
      }
      if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
        return { kind: 'arithmetic', operator: op, left, right, text: `${left.text} ${op} ${right.text}` }
      }
      return null
    }
    case 'expr_list': {
      // Right side of IN / NOT IN / BETWEEN: a parenthesized value list.
      const items: Expression[] = []
      for (const item of (raw.value ?? []) as Raw[]) {
        const interpreted = interpretExpression(item)
        if (interpreted === null) return null
        items.push(interpreted)
      }
      const allLiterals = items.every((item) => item.kind === 'literal')
      return {
        kind: 'list',
        exprs: items,
        values: allLiterals ? items.map((item) => (item as LiteralExpr).value) : null,
        text: `(${items.map((item) => item.text).join(', ')})`,
      }
    }
    case 'unary_expr': {
      const operand = interpretExpression(raw.expr)
      if (!operand) return null
      const op = String(raw.operator).toUpperCase()
      if (op === 'NOT') return { kind: 'not', operand, text: `NOT ${operand.text}` }
      if (op === '-') return { kind: 'unary_minus', operand, text: `-${operand.text}` }
      return null
    }
    case 'aggr_func': {
      const name = String(raw.name).toUpperCase()
      if (!AGGREGATE_NAMES.has(name)) return null
      const args = raw.args ?? {}
      const distinct = Boolean(args.distinct)
      let argument: Expression | null = null
      if (args.expr?.type === 'star') {
        argument = null // COUNT(*)
      } else {
        argument = interpretExpression(args.expr)
      }
      const argText = argument ? argument.text : '*'
      const distinctText = distinct ? 'DISTINCT ' : ''
      const call: AggregateCall = {
        name: name as AggregateCall['name'],
        argument,
        distinct,
        text: `${name}(${distinctText}${argText})`,
      }
      return {
        kind: 'aggregate',
        call,
        text: call.text,
      }
    }
    default:
      return null
  }
}

function isAggregateExpression(expr: Expression): boolean {
  switch (expr.kind) {
    case 'aggregate':
      return true
    case 'logical':
    case 'comparison':
    case 'arithmetic':
      return isAggregateExpression(expr.left) || isAggregateExpression(expr.right)
    case 'not':
    case 'unary_minus':
      return isAggregateExpression(expr.operand)
    default:
      return false
  }
}

export { isAggregateExpression }

function textOfRaw(raw: Raw): string {
  // Faithful-ish text rendering for unsupported-expression reporting.
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  switch (raw.type) {
    case 'column_ref':
      return [raw.table, columnNameOf(raw.column)].filter(Boolean).join('.')
    case 'number':
    case 'single_quote_string':
    case 'double_quote_string':
      return String(raw.value)
    case 'null':
      return 'NULL'
    case 'star':
      return raw.table ? `${raw.table}.*` : '*'
    case 'expr_list':
      return `(${((raw.value ?? []) as Raw[]).map(textOfRaw).join(', ')})`
    case 'aggr_func':
    case 'function': {
      // v5.4: plain functions carry name as { name: [{ value }] }.
      const name =
        typeof raw.name === 'string'
          ? raw.name
          : typeof raw.name?.name === 'string'
            ? raw.name.name
            : ((raw.name?.name ?? [])
                .map((part: { value?: unknown }) => String(part?.value ?? ''))
                .filter(Boolean)
                .join('.') || 'expression')
      const args = raw.args
      const argList = args?.type === 'expr_list' ? ((args.value ?? []) as Raw[]) : args?.expr ? [args.expr] : []
      const argText = argList[0]?.type === 'star' ? '*' : argList.map(textOfRaw).join(', ')
      return `${String(name).toUpperCase()}(${argText})`
    }
    case 'binary_expr':
      return `${textOfRaw(raw.left)} ${raw.operator} ${textOfRaw(raw.right)}`
    case 'case_expr':
      return 'CASE expression'
    case 'cast_expr':
      return 'CAST expression'
    default:
      return raw.type ?? 'expression'
  }
}

/**
 * Interpret one SQL statement. Returns the structure plus the list of
 * unsupported constructs found. Never throws.
 */
export function interpretStatement(sql: string): InterpretationResult {
  const statementType = detectStatementType(sql)
  if (statementType !== 'SELECT') {
    return { structure: null, unsupportedReasons: ['Only SELECT queries can be visualized.'] }
  }
  const ast = parseSql(sql)
  if (!ast || ast.type !== 'select') {
    return { structure: null, unsupportedReasons: ['The statement could not be parsed as a SELECT.'] }
  }

  const unsupportedReasons: string[] = []

  // WITH / CTEs, subqueries and compound selects are out of scope.
  if (ast.with != null) unsupportedReasons.push('WITH (common table expressions) are not visualizable yet.')
  if (Array.isArray(ast.options)) unsupportedReasons.push('Compound selects (UNION / INTERSECT / EXCEPT) are not visualizable yet.')
  if (ast._next != null || ast.previous != null) {
    unsupportedReasons.push('Compound selects (UNION / INTERSECT / EXCEPT) are not visualizable yet.')
  }

  const fromList: Raw[] = Array.isArray(ast.from) ? ast.from : []
  if (fromList.length === 0) {
    unsupportedReasons.push('Queries without a FROM clause (SELECT literals) are not visualizable.')
    return { structure: null, unsupportedReasons }
  }

  const primary = fromList[0]
  const from: TableRef = {
    name: String(primary.table),
    alias: typeof primary.as === 'string' && primary.as.length > 0 ? primary.as : null,
  }

  const joins: JoinClause[] = []
  for (let i = 1; i < fromList.length; i++) {
    const entry = fromList[i]
    if (entry.join == null) {
      unsupportedReasons.push('Comma cross joins (FROM a, b) are not visualizable yet. Use explicit JOIN … ON.')
      continue
    }
    const joinType = String(entry.join).toUpperCase() as 'INNER JOIN' | 'LEFT JOIN' | 'CROSS JOIN' | string
    if (joinType !== 'INNER JOIN' && joinType !== 'LEFT JOIN' && joinType !== 'CROSS JOIN') {
      unsupportedReasons.push(`${String(entry.join)} is not visualizable yet.`)
      continue
    }
    const on = interpretExpression(entry.on)
    if (joinType !== 'CROSS JOIN' && on === null) {
      unsupportedReasons.push('The JOIN condition uses an expression that is not visualizable yet.')
      continue
    }
    joins.push({
      type: joinType,
      table: {
        name: String(entry.table),
        alias: typeof entry.as === 'string' && entry.as.length > 0 ? entry.as : null,
      },
      on,
      text: `${joinType} ${entry.as ? `${entry.table} ${entry.as}` : entry.table}${on ? ` ON ${on.text}` : ''}`,
    })
  }

  // SELECT list
  const selectItems: SelectItem[] = []
  let selectAll = false
  const columnList: Raw[] = Array.isArray(ast.columns) ? ast.columns : []
  const isStarExpr = (expr: Raw): boolean =>
    expr?.type === 'star' || (expr?.type === 'column_ref' && columnNameOf(expr.column) === '*')
  if (columnList.length === 1 && isStarExpr(columnList[0]?.expr) && columnList[0]?.as == null) {
    selectAll = true
  }
  for (const item of columnList) {
    const expr = interpretExpression(item.expr)
    if (expr === null) {
      unsupportedReasons.push(`SELECT expression "${textOfRaw(item.expr)}" is not visualizable yet.`)
      continue
    }
    selectItems.push({
      expression: expr,
      alias: typeof item.as === 'string' && item.as.length > 0 ? item.as : null,
      text: expr.text,
    })
  }
  if (selectItems.length === 0 && !selectAll) {
    unsupportedReasons.push('No visualizable SELECT expressions found.')
  }

  const where = interpretExpression(ast.where)
  if (ast.where != null && where === null) {
    unsupportedReasons.push(`WHERE uses an expression that is not visualizable yet (${textOfRaw(ast.where)}).`)
  }

  const groupBy: Expression[] = []
  if (ast.groupby != null) {
    const groupCols: Raw[] = ast.groupby.columns ?? (Array.isArray(ast.groupby) ? ast.groupby : [])
    for (const raw of groupCols) {
      const expr = interpretExpression(raw)
      if (expr === null) {
        unsupportedReasons.push(`GROUP BY expression "${textOfRaw(raw)}" is not visualizable yet.`)
        continue
      }
      groupBy.push(expr)
    }
  }

  const having = interpretExpression(ast.having)
  if (ast.having != null && having === null) {
    unsupportedReasons.push(`HAVING uses an expression that is not visualizable yet (${textOfRaw(ast.having)}).`)
  }

  const orderBy: OrderByTerm[] = []
  if (Array.isArray(ast.orderby)) {
    for (const term of ast.orderby) {
      const expr = interpretExpression(term.expr)
      if (expr === null) {
        unsupportedReasons.push(`ORDER BY expression "${textOfRaw(term.expr)}" is not visualizable yet.`)
        continue
      }
      orderBy.push({
        expression: expr,
        direction: String(term.type ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
        text: expr.text,
      })
    }
  }

  let limit: LimitClause | null = null
  if (ast.limit != null) {
    const values: Raw[] = Array.isArray(ast.limit.value) ? ast.limit.value : []
    const evaluated = values.map((value) => interpretExpression(value))
    if (evaluated.some((value) => value === null || value.kind !== 'literal' || typeof value.value !== 'number')) {
      unsupportedReasons.push('LIMIT / OFFSET must use constant numbers to be visualizable.')
    } else {
      // Two numeric forms exist:
      //   `LIMIT n OFFSET m`  → seperator "offset", value = [n, m]
      //   `LIMIT m, n`        → seperator ",",     value = [m, n]
      // SQLite semantics for the comma form: first number is the OFFSET,
      // second is the COUNT.
      const commaForm = String(ast.limit.seperator ?? '') === ','
      const first = (evaluated[0] as LiteralExpr).value as number
      const second = evaluated.length > 1 ? ((evaluated[1] as LiteralExpr).value as number) : 0
      const limitCount = commaForm ? second : first
      const offsetCount = commaForm ? first : second
      limit = {
        limit: limitCount,
        offset: offsetCount,
        text: `LIMIT ${limitCount}${offsetCount > 0 ? ` OFFSET ${offsetCount}` : ''}`,
      }
    }
  }

  // Collect aggregates across select list and HAVING.
  const aggregates: AggregateCall[] = []
  const collectAggregates = (expr: Expression | null) => {
    if (expr === null) return
    switch (expr.kind) {
      case 'aggregate':
        aggregates.push(expr.call)
        break
      case 'logical':
      case 'comparison':
      case 'arithmetic':
        collectAggregates(expr.left)
        collectAggregates(expr.right)
        break
      case 'not':
      case 'unary_minus':
        collectAggregates(expr.operand)
        break
      default:
        break
    }
  }
  for (const item of selectItems) collectAggregates(item.expression)
  collectAggregates(having)

  const structure: QueryStructure = {
    distinct: ast.distinct === 'DISTINCT' || ast.distinct?.type === 'DISTINCT',
    selectItems,
    selectAll,
    from,
    joins,
    where,
    groupBy,
    having,
    orderBy,
    limit,
    aggregates,
    statementType,
  }

  return { structure, unsupportedReasons }
}

/**
 * Interpret the first executable statement of a SQL batch.
 * Returns unsupported reasons when the batch has zero or many statements.
 */
export function interpretQuery(_sql: string, statements: string[]): InterpretationResult {
  if (statements.length === 0) {
    return { structure: null, unsupportedReasons: ['There is no SQL statement to visualize.'] }
  }
  if (statements.length > 1) {
    return {
      structure: null,
      unsupportedReasons: [
        `Multiple statements are not visualizable. Write a single SELECT — the editor currently contains ${statements.length} statements.`,
      ],
    }
  }
  return interpretStatement(statements[0] as string)
}
