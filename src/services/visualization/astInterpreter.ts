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
import type { VisualizedStage } from '../../types/visualization'

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

/**
 * A nested query block used as an expression. Node-sql-parser wraps
 * subquery ASTs in `{ ast: { type: 'select' }, parentheses: true }`
 * (scalar positions) or as an item of an `expr_list` (IN / EXISTS).
 */
export interface SubqueryExpr {
  kind: 'subquery'
  /** Stable id shared with the nested trace (e.g. "q2"). */
  id: string
  query: QueryStructure
  text: string
  /** Outer clause whose expression contains this block. */
  parentStage: VisualizedStage | null
  /**
   * True when the block qualified-references a table that is not part of
   * its own FROM/JOIN scope. Unqualified outer references cannot be
   * detected here (no schema); the simulator resolves them against the
   * real table columns before executing the block and reports them as
   * correlated instead of supported.
   */
  correlated: boolean
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
  | SubqueryExpr

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

/**
 * One non-recursive CTE definition from a WITH clause. The body is a
 * full query block with its own deterministic id; `dependencies` names
 * earlier CTEs it reads (resolved to ids by the simulator).
 */
export interface CteDefinition {
  name: string
  /** Explicit column list from `WITH name(a, b) AS …`, or null. */
  columns: string[] | null
  query: QueryStructure
  /** Names of earlier CTEs this definition reads. */
  dependencies: string[]
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
  /** Stable query-block id (root and each nested block get one). */
  id: string
  /** Block kind: root statement, nested scalar subquery, or CTE body. */
  blockKind: 'root' | 'scalar' | 'cte'
  /** Parent block id, null for the root block. */
  parentId: string | null
  /** Nesting depth relative to the root block (root = 0). */
  depth: number
  /** Parent stage whose expression consumes this block (null for root). */
  consumingStage: VisualizedStage | null
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
  /** CTE definitions of this block's WITH clause (root only today). */
  ctes: CteDefinition[]
  /** Nested query blocks used by expressions in this block. */
  subqueries: SubqueryExpr[]
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

/** CTE name from the parser's `{ name: { value } }` shape. */
function cteNameOf(raw: Raw): string {
  const value = raw?.name?.value ?? raw?.name
  return typeof value === 'string' ? value : String(value ?? '')
}

/**
 * Relation names read by a block (FROM/JOIN), including nested scalar
 * subqueries. Used to derive explicit CTE dependencies after the body
 * has been interpreted.
 */
function relationNamesOf(structure: QueryStructure, out: Set<string> = new Set()): Set<string> {
  out.add(structure.from.name.toLowerCase())
  for (const join of structure.joins) out.add(join.table.name.toLowerCase())
  for (const subquery of structure.subqueries) relationNamesOf(subquery.query, out)
  return out
}

const COMPARISON_OPERATORS = new Set(['=', '!=', '<>', '>', '<', '>=', '<=', 'IN', 'NOT IN', 'BETWEEN', 'NOT BETWEEN', 'LIKE', 'NOT LIKE', 'IS', 'IS NOT'])
const AGGREGATE_NAMES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'])

/** Shared state while interpreting one statement and its nested blocks. */
interface InterpretContext {
  /** Deterministic ids for query blocks (q1, q2, …). */
  nextId: () => string
  /** Reasons collected across the whole statement. */
  reasons: string[]
  /** Outer clause currently being interpreted. */
  parentStage: VisualizedStage | null
  /** Subquery expressions collected for the current query block. */
  collected: SubqueryExpr[]
  /** Block currently being interpreted (null before the root is created). */
  blockId: string | null
  /** Depth of the block currently being interpreted (root = 0). */
  depth: number
  /**
   * Whether a WITH clause in the current AST is supported. Only the
   * root statement accepts CTEs; nested blocks reject them conservatively.
   */
  allowCtes: boolean
}

function createInterpretContext(): InterpretContext {
  let counter = 0
  return {
    nextId: () => `q${++counter}`,
    reasons: [],
    parentStage: null,
    collected: [],
    blockId: null,
    depth: 0,
    allowCtes: true,
  }
}

/** Raw subquery AST inside a wrapper node, or null. */
function subqueryAstOf(raw: Raw): Raw | null {
  if (raw == null || typeof raw !== 'object') return null
  if (raw.type === 'select') return raw
  if (raw.ast != null && raw.ast.type === 'select') return raw.ast
  return null
}

/** Plain function name from the parser's several shapes. */
function rawFunctionName(raw: Raw): string {
  if (typeof raw.name === 'string') return raw.name
  const name = raw.name?.name
  if (typeof name === 'string') return name
  if (Array.isArray(name)) {
    return name
      .map((part: { value?: unknown }) => String(part?.value ?? ''))
      .filter(Boolean)
      .join('.')
  }
  return ''
}

/** Collect table qualifiers referenced by expressions in one block. */
function collectQualifiedTables(expr: Expression | null, tables: Set<string>): void {
  if (expr === null) return
  switch (expr.kind) {
    case 'column':
      if (expr.table !== null) tables.add(expr.table.toLowerCase())
      break
    case 'comparison':
    case 'logical':
    case 'arithmetic':
      collectQualifiedTables(expr.left, tables)
      collectQualifiedTables(expr.right, tables)
      break
    case 'not':
    case 'unary_minus':
      collectQualifiedTables(expr.operand, tables)
      break
    case 'aggregate':
      collectQualifiedTables(expr.call.argument, tables)
      break
    case 'list':
      for (const item of expr.exprs) collectQualifiedTables(item, tables)
      break
    default:
      break
  }
}

/**
 * Conservative correlation check available without table schemas: a
 * qualified column whose table is not in this block's FROM/JOIN scope
 * must come from an outer query.
 */
function isPotentiallyCorrelated(structure: QueryStructure): boolean {
  const inner = new Set<string>()
  inner.add((structure.from.alias ?? structure.from.name).toLowerCase())
  inner.add(structure.from.name.toLowerCase())
  for (const join of structure.joins) {
    inner.add((join.table.alias ?? join.table.name).toLowerCase())
    inner.add(join.table.name.toLowerCase())
  }
  const referenced = new Set<string>()
  for (const item of structure.selectItems) collectQualifiedTables(item.expression, referenced)
  collectQualifiedTables(structure.where, referenced)
  for (const expr of structure.groupBy) collectQualifiedTables(expr, referenced)
  collectQualifiedTables(structure.having, referenced)
  for (const term of structure.orderBy) collectQualifiedTables(term.expression, referenced)
  for (const join of structure.joins) collectQualifiedTables(join.on, referenced)
  for (const table of referenced) {
    if (!inner.has(table)) return true
  }
  return false
}

/** Compact SQL text for a nested block, used in labels and inspector data. */
export function structureText(structure: QueryStructure): string {
  const columns = structure.selectAll
    ? '*'
    : structure.selectItems
        .map((item) => (item.alias !== null ? `${item.text} AS ${item.alias}` : item.text))
        .join(', ')
  let text = `SELECT ${structure.distinct ? 'DISTINCT ' : ''}${columns} FROM ${structure.from.name}`
  if (structure.from.alias !== null) text += ` ${structure.from.alias}`
  for (const join of structure.joins) text += ` ${join.text}`
  if (structure.where !== null) text += ` WHERE ${structure.where.text}`
  if (structure.groupBy.length > 0) {
    text += ` GROUP BY ${structure.groupBy.map((expr) => expr.text).join(', ')}`
  }
  if (structure.having !== null) text += ` HAVING ${structure.having.text}`
  if (structure.orderBy.length > 0) {
    text += ` ORDER BY ${structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', ')}`
  }
  if (structure.limit !== null) text += ` ${structure.limit.text}`
  return text
}

/** Convert a raw parser expression into our typed expression tree. */
export function interpretExpression(
  raw: Raw,
  context: InterpretContext = createInterpretContext(),
): Expression | null {
  if (raw == null) return null

  // A nested SELECT used as an expression (scalar subquery).
  const subqueryAst = subqueryAstOf(raw)
  if (subqueryAst !== null) {
    const nested = interpretSelectAst(subqueryAst, {
      ...context,
      collected: [],
      allowCtes: false,
    })
    if (nested === null) return null
    const expr: SubqueryExpr = {
      kind: 'subquery',
      id: nested.id,
      query: nested,
      text: `(${structureText(nested)})`,
      parentStage: context.parentStage,
      correlated: isPotentiallyCorrelated(nested),
    }
    context.collected.push(expr)
    if (expr.correlated) {
      context.reasons.push(
        `Correlated subqueries are not visualizable yet: ${expr.text} reads a column from the outer query.`,
      )
    }
    return expr
  }

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
      const left = interpretExpression(raw.left, context)
      const right = interpretExpression(raw.right, context)
      if (!left || !right) return null
      const op = String(raw.operator).toUpperCase()
      if (op === 'AND' || op === 'OR') {
        return { kind: 'logical', operator: op, left, right, text: `${left.text} ${op} ${right.text}` }
      }
      if (op === 'IN' || op === 'NOT IN') {
        if (right.kind === 'subquery') {
          context.reasons.push('IN / NOT IN subqueries are not visualizable yet.')
          return null
        }
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
      const items: Raw[] = (raw.value ?? []) as Raw[]
      // A single subquery in parentheses (IN / EXISTS argument) is a
      // nested block, not a literal value list.
      if (items.length === 1 && subqueryAstOf(items[0]) !== null) {
        return interpretExpression(items[0], context)
      }
      const interpreted: Expression[] = []
      for (const item of items) {
        const expr = interpretExpression(item, context)
        if (expr === null) return null
        interpreted.push(expr)
      }
      const allLiterals = interpreted.every((item) => item.kind === 'literal')
      return {
        kind: 'list',
        exprs: interpreted,
        values: allLiterals ? interpreted.map((item) => (item as LiteralExpr).value) : null,
        text: `(${interpreted.map((item) => item.text).join(', ')})`,
      }
    }
    case 'unary_expr': {
      const op = String(raw.operator).toUpperCase()
      if (op === 'NOT EXISTS') {
        context.reasons.push('EXISTS / NOT EXISTS subqueries are not visualizable yet.')
        return null
      }
      const operand = interpretExpression(raw.expr, context)
      if (!operand) return null
      if (op === 'NOT') return { kind: 'not', operand, text: `NOT ${operand.text}` }
      if (op === '-') return { kind: 'unary_minus', operand, text: `-${operand.text}` }
      return null
    }
    case 'function': {
      if (rawFunctionName(raw).toUpperCase() === 'EXISTS') {
        context.reasons.push('EXISTS / NOT EXISTS subqueries are not visualizable yet.')
        return null
      }
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
        argument = interpretExpression(args.expr, context)
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
 * Interpret one SELECT AST node (root or nested) into a QueryStructure.
 * Reasons accumulate in `context.reasons`; returns null when the block
 * cannot be represented faithfully.
 *
 * `blockKind` distinguishes a CTE definition body from a scalar
 * subquery; the root is inferred from the context.
 */
function interpretSelectAst(
  ast: Raw,
  context: InterpretContext,
  blockKind?: 'scalar' | 'cte',
): QueryStructure | null {
  const unsupportedReasons = context.reasons
  if (ast == null || ast.type !== 'select') {
    unsupportedReasons.push('A nested statement could not be parsed as a SELECT.')
    return null
  }

  const id = context.nextId()
  const subqueries: SubqueryExpr[] = []
  // Expressions inside this block belong to `id`, and any nested block
  // they contain is one level deeper with `id` as its parent.
  const blockContext: InterpretContext = {
    ...context,
    blockId: id,
    depth: context.depth + 1,
  }
  const clause = (stage: VisualizedStage): InterpretContext => ({
    ...blockContext,
    parentStage: stage,
    collected: subqueries,
  })

  // --- WITH / non-recursive CTEs ------------------------------------------
  // Every CTE definition becomes an independent child query block of the
  // current statement, in declaration order. Dependencies are recorded
  // by name here and resolved to block ids by the simulator.
  const ctes: CteDefinition[] = []
  if (ast.with != null) {
    if (!context.allowCtes) {
      unsupportedReasons.push(
        'Nested WITH clauses inside subqueries or CTE definitions are not visualizable yet.',
      )
      return null
    }
    const definitions: Raw[] = Array.isArray(ast.with) ? ast.with : []
    if (definitions.some((definition) => definition?.recursive === true)) {
      unsupportedReasons.push(
        'Recursive common table expressions (WITH RECURSIVE) are not visualizable yet.',
      )
      return null
    }
    const seen = new Map<string, CteDefinition>()
    for (const definition of definitions) {
      const name = cteNameOf(definition)
      if (name === '') {
        unsupportedReasons.push('A WITH clause contains a CTE without a name.')
        return null
      }
      const key = name.toLowerCase()
      if (seen.has(key)) {
        unsupportedReasons.push(`CTE name "${name}" is declared more than once in the same WITH clause.`)
        return null
      }
      const cteAst = definition?.stmt?.ast ?? definition?.stmt
      if (cteAst == null || cteAst.type !== 'select') {
        unsupportedReasons.push(
          `CTE "${name}" does not contain a SELECT statement; only SELECT CTE bodies are visualizable.`,
        )
        return null
      }
      if (cteAst.with != null) {
        unsupportedReasons.push(
          `CTE "${name}" contains a nested WITH clause, which is not visualizable yet.`,
        )
        return null
      }
      const cteContext: InterpretContext = {
        ...blockContext,
        parentStage: null,
        collected: [],
        allowCtes: false,
      }
      const query = interpretSelectAst(cteAst, cteContext, 'cte')
      if (query === null) {
        unsupportedReasons.push(`CTE "${name}" could not be interpreted.`)
        return null
      }
      const columns: string[] | null = Array.isArray(definition.columns)
        ? definition.columns.map((column: Raw) => columnNameOf(column?.column ?? column))
        : null
      const referenced = relationNamesOf(query)
      const dependencies: string[] = []
      for (const [previousKey, previous] of seen) {
        if (referenced.has(previousKey)) dependencies.push(previous.name)
      }
      const cte: CteDefinition = { name, columns, query, dependencies }
      ctes.push(cte)
      seen.set(key, cte)
    }
  }

  // Compound selects and derived tables remain out of scope.
  if (Array.isArray(ast.options)) unsupportedReasons.push('Compound selects (UNION / INTERSECT / EXCEPT) are not visualizable yet.')
  if (ast._next != null || ast.previous != null) {
    unsupportedReasons.push('Compound selects (UNION / INTERSECT / EXCEPT) are not visualizable yet.')
  }

  const fromList: Raw[] = Array.isArray(ast.from) ? ast.from : []
  if (fromList.length === 0) {
    unsupportedReasons.push('Queries without a FROM clause (SELECT literals) are not visualizable.')
    return null
  }

  const primary = fromList[0]
  if (subqueryAstOf(primary) !== null || primary.expr != null) {
    unsupportedReasons.push(
      'Derived tables (FROM (SELECT …)) are not visualizable yet. Use a CTE or a JOIN instead.',
    )
    return null
  }
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
    if (subqueryAstOf(entry) !== null || entry.expr != null) {
      unsupportedReasons.push('Derived tables in JOIN clauses are not visualizable yet.')
      continue
    }
    const on = interpretExpression(entry.on, clause('JOIN'))
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
    const expr = interpretExpression(item.expr, clause('SELECT'))
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

  const where = interpretExpression(ast.where, clause('WHERE'))
  if (ast.where != null && where === null) {
    unsupportedReasons.push(`WHERE uses an expression that is not visualizable yet (${textOfRaw(ast.where)}).`)
  }

  const groupBy: Expression[] = []
  if (ast.groupby != null) {
    const groupCols: Raw[] = ast.groupby.columns ?? (Array.isArray(ast.groupby) ? ast.groupby : [])
    for (const raw of groupCols) {
      const expr = interpretExpression(raw, clause('GROUP_BY'))
      if (expr === null) {
        unsupportedReasons.push(`GROUP BY expression "${textOfRaw(raw)}" is not visualizable yet.`)
        continue
      }
      groupBy.push(expr)
    }
  }

  const having = interpretExpression(ast.having, clause('HAVING'))
  if (ast.having != null && having === null) {
    unsupportedReasons.push(`HAVING uses an expression that is not visualizable yet (${textOfRaw(ast.having)}).`)
  }

  const orderBy: OrderByTerm[] = []
  if (Array.isArray(ast.orderby)) {
    for (const term of ast.orderby) {
      const expr = interpretExpression(term.expr, clause('ORDER_BY'))
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
    const evaluated = values.map((value) => interpretExpression(value, clause('LIMIT')))
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

  // Collect aggregates across select list and HAVING. Subqueries are
  // separate query blocks and their aggregates do not belong to this one.
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
    id,
    blockKind: context.blockId === null ? 'root' : (blockKind ?? 'scalar'),
    parentId: context.blockId,
    depth: context.depth,
    consumingStage: context.blockId === null ? null : context.parentStage,
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
    ctes,
    subqueries,
    statementType: 'SELECT',
  }

  return structure
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

  const context = createInterpretContext()
  const structure = interpretSelectAst(ast, context)
  if (structure === null && context.reasons.length === 0) {
    context.reasons.push('The query could not be interpreted.')
  }
  return { structure, unsupportedReasons: context.reasons }
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
