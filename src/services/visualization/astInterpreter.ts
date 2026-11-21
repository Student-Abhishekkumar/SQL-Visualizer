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
import type { SetOperator, VisualizedStage } from '../../types/visualization'
import {
  splitCompoundQuery,
  type CompoundSplitOutcome,
} from './compoundSplitter'
import { normalizeCollation } from './sqliteAffinity'

export type { SetOperator }

/**
 * Parser `set_op` token → shared operator. node-sql-parser's SQLite
 * grammar only emits the UNION forms, but INTERSECT and EXCEPT are mapped
 * here too so both the parser path and the splitter fallback describe a
 * compound query the same way.
 */
const SET_OPERATORS: Readonly<Record<string, SetOperator>> = {
  union: 'UNION',
  'union all': 'UNION ALL',
  intersect: 'INTERSECT',
  except: 'EXCEPT',
}

/** Shared operator → parser token used when rebuilding a fallback AST chain. */
const PARSER_SET_OPERATORS: Readonly<Record<SetOperator, string>> = {
  UNION: 'union',
  'UNION ALL': 'union all',
  INTERSECT: 'intersect',
  EXCEPT: 'except',
}

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
  /**
   * SQLite storage class of a numeric literal (`10` is integer, `10.0`
   * and `1e2` are real). Needed so TEXT affinity formats the value the
   * way SQLite does (`'10'` vs `'10.0'`).
   */
  numberKind?: 'integer' | 'real'
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

/**
 * `expr COLLATE BINARY|NOCASE`. Only the two collations SQLite's core
 * provides with deterministic ASCII semantics are representable; any
 * other name is rejected during interpretation rather than ignored.
 */
export interface CollateExpr {
  kind: 'collate'
  collation: 'BINARY' | 'NOCASE'
  operand: Expression
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
   * How the subquery's result is consumed: a scalar value, a value list
   * for IN / NOT IN, or an existence test for EXISTS / NOT EXISTS.
   */
  usage: 'scalar' | 'in' | 'exists'
  /**
   * True when the block qualified-references a table that is not part of
   * its own FROM/JOIN scope. Unqualified outer references cannot be
   * detected here (no schema); the simulator resolves them against the
   * real table columns before executing the block and reports them as
   * correlated instead of supported.
   */
  correlated: boolean
}

/** `expr IN (subquery)` / `expr NOT IN (subquery)`. */
export interface InSubqueryExpr {
  kind: 'in_subquery'
  operator: 'IN' | 'NOT IN'
  left: Expression
  subquery: SubqueryExpr
  text: string
}

/** `EXISTS (subquery)` / `NOT EXISTS (subquery)`. */
export interface ExistsSubqueryExpr {
  kind: 'exists_subquery'
  negated: boolean
  subquery: SubqueryExpr
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
  | CollateExpr
  | ListExpr
  | AggregateExpr
  | SubqueryExpr
  | InSubqueryExpr
  | ExistsSubqueryExpr

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
  /**
   * Block kind: root statement, scalar subquery, CTE body, the subquery
   * form of IN / EXISTS, or one SELECT branch of a compound statement.
   */
  blockKind: 'root' | 'scalar' | 'cte' | 'in' | 'exists' | 'compound'
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
  /**
   * Compound (set-operation) branches in evaluation order. Set on the
   * synthetic root block of a compound statement (UNION, UNION ALL,
   * INTERSECT or EXCEPT) and null for every ordinary SELECT block.
   */
  compound: CompoundSelect | null
  statementType: StatementType
}

/**
 * One SELECT branch of a compound query and its combining operator.
 * `operator` is null for the first branch; every later branch records the
 * operator that joins it to the accumulated result, in left-to-right
 * (SQLite) evaluation order.
 */
export interface CompoundBranch {
  query: QueryStructure
  /** Operator combining this branch with the previous one (null for first). */
  operator: SetOperator | null
}

/** Ordered branches of one compound SELECT. */
export interface CompoundSelect {
  branches: CompoundBranch[]
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
  if (structure.compound !== null) {
    for (const branch of structure.compound.branches) relationNamesOf(branch.query, out)
  }
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
    case 'collate':
      collectQualifiedTables(expr.operand, tables)
      break
    case 'aggregate':
      collectQualifiedTables(expr.call.argument, tables)
      break
    case 'list':
      for (const item of expr.exprs) collectQualifiedTables(item, tables)
      break
    case 'in_subquery':
      collectQualifiedTables(expr.left, tables)
      break
    case 'exists_subquery':
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
  if (structure.compound !== null) {
    let text = structure.compound.branches
      .map((branch, index) =>
        index === 0 || branch.operator === null
          ? structureText(branch.query)
          : `${branch.operator} ${structureText(branch.query)}`,
      )
      .join(' ')
    if (structure.orderBy.length > 0) {
      text += ` ORDER BY ${structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', ')}`
    }
    if (structure.limit !== null) text += ` ${structure.limit.text}`
    return text
  }
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

/** Collation name attached to a raw node (`x COLLATE NOCASE`), or null. */
function rawCollationOf(raw: Raw): string | null {
  const direct = raw?.collate?.collate?.name ?? raw?.collate?.name
  if (typeof direct === 'string' && direct.length > 0) return direct
  const suffixed =
    raw?.suffix?.collate?.collate?.name ?? raw?.suffix?.collate?.name
  if (typeof suffixed === 'string' && suffixed.length > 0) return suffixed
  return null
}

/** Copy of a raw node with its COLLATE annotation removed. */
function withoutCollation(raw: Raw): Raw {
  const copy: Raw = { ...raw }
  if (copy.collate != null) copy.collate = null
  if (copy.suffix != null && copy.suffix.collate != null) {
    const suffix: Raw = { ...copy.suffix }
    delete suffix.collate
    copy.suffix = suffix
  }
  return copy
}

/** Parse a numeric literal's raw text into a value plus storage class. */
function numericLiteral(rawValue: unknown): { value: number; numberKind: 'integer' | 'real' } {
  const text = String(rawValue)
  return {
    value: Number(text),
    numberKind: /[.eE]/.test(text) ? 'real' : 'integer',
  }
}

/** Convert a raw parser expression into our typed expression tree. */
export function interpretExpression(
  raw: Raw,
  context: InterpretContext = createInterpretContext(),
): Expression | null {
  if (raw == null) return null

  // COLLATE attaches to the node it follows (column_ref.collate for
  // identifiers, node.suffix.collate for other expressions). Validate the
  // name now so an unsupported collation is rejected before simulation.
  const collationName = rawCollationOf(raw)
  if (collationName !== null) {
    const collation = normalizeCollation(collationName)
    if (collation === null) {
      context.reasons.push(
        `Collation "${collationName}" is not visualizable yet; only BINARY and NOCASE are supported.`,
      )
      return null
    }
    const operand = interpretExpression(withoutCollation(raw), context)
    if (operand === null) return null
    return {
      kind: 'collate',
      collation,
      operand,
      text: `${operand.text} COLLATE ${collation}`,
    }
  }

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
      usage: 'scalar',
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
    case 'number': {
      const { value, numberKind } = numericLiteral(raw.value)
      return { kind: 'literal', value, numberKind, text: String(raw.value) }
    }
    case 'bigint': {
      const { value, numberKind } = numericLiteral(raw.value)
      return { kind: 'literal', value, numberKind, text: String(raw.value) }
    }
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
      if ((op === 'IN' || op === 'NOT IN') && right.kind === 'subquery') {
        right.usage = 'in'
        right.query.blockKind = 'in'
        return {
          kind: 'in_subquery',
          operator: op,
          left,
          subquery: right,
          text: `${left.text} ${op} ${right.text}`,
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
        const nested = interpretExpression(raw.expr, context)
        if (nested === null || nested.kind !== 'subquery') {
          context.reasons.push('EXISTS requires a subquery argument.')
          return null
        }
        nested.usage = 'exists'
        nested.query.blockKind = 'exists'
        return {
          kind: 'exists_subquery',
          negated: true,
          subquery: nested,
          text: `NOT EXISTS ${nested.text}`,
        }
      }
      const operand = interpretExpression(raw.expr, context)
      if (!operand) return null
      if (op === 'NOT') return { kind: 'not', operand, text: `NOT ${operand.text}` }
      if (op === '-') return { kind: 'unary_minus', operand, text: `-${operand.text}` }
      return null
    }
    case 'function': {
      if (rawFunctionName(raw).toUpperCase() === 'EXISTS') {
        const nested = interpretExpression(raw.args, context)
        if (nested === null || nested.kind !== 'subquery') {
          context.reasons.push('EXISTS requires a subquery argument.')
          return null
        }
        nested.usage = 'exists'
        nested.query.blockKind = 'exists'
        return {
          kind: 'exists_subquery',
          negated: false,
          subquery: nested,
          text: `EXISTS ${nested.text}`,
        }
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
    case 'collate':
      return isAggregateExpression(expr.operand)
    case 'in_subquery':
      return isAggregateExpression(expr.left)
    case 'exists_subquery':
      return false
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

/** Interpret an AST ORDER BY list into typed terms. */
function interpretOrderByList(
  raw: Raw,
  context: InterpretContext,
  unsupportedReasons: string[],
  label: string,
): OrderByTerm[] {
  const orderBy: OrderByTerm[] = []
  if (!Array.isArray(raw)) return orderBy
  for (const term of raw) {
    const expr = interpretExpression(term.expr, context)
    if (expr === null) {
      unsupportedReasons.push(`${label} expression "${textOfRaw(term.expr)}" is not visualizable yet.`)
      continue
    }
    orderBy.push({
      expression: expr,
      direction: String(term.type ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
      text: expr.text,
    })
  }
  return orderBy
}

/** Interpret an AST LIMIT clause (both `LIMIT n OFFSET m` forms). */
function interpretLimitClause(
  raw: Raw,
  context: InterpretContext,
  unsupportedReasons: string[],
): LimitClause | null {
  if (raw == null) return null
  const values: Raw[] = Array.isArray(raw.value) ? raw.value : []
  const evaluated = values.map((value) => interpretExpression(value, context))
  if (evaluated.some((value) => value === null || value.kind !== 'literal' || typeof value.value !== 'number')) {
    unsupportedReasons.push('LIMIT / OFFSET must use constant numbers to be visualizable.')
    return null
  }
  // Two numeric forms exist:
  //   `LIMIT n OFFSET m`  → seperator "offset", value = [n, m]
  //   `LIMIT m, n`        → seperator ",",     value = [m, n]
  // SQLite semantics for the comma form: first number is the OFFSET,
  // second is the COUNT.
  const commaForm = String(raw.seperator ?? '') === ','
  const first = (evaluated[0] as LiteralExpr).value as number
  const second = evaluated.length > 1 ? ((evaluated[1] as LiteralExpr).value as number) : 0
  const limitCount = commaForm ? second : first
  const offsetCount = commaForm ? first : second
  return {
    limit: limitCount,
    offset: offsetCount,
    text: `LIMIT ${limitCount}${offsetCount > 0 ? ` OFFSET ${offsetCount}` : ''}`,
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
  blockKind?: 'scalar' | 'cte' | 'compound',
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

  // --- compound SELECT (UNION / UNION ALL) -------------------------------
  // node-sql-parser chains branches through `_next` and stores the
  // operator joining the current node to the next one on `set_op`. The
  // whole compound's ORDER BY / LIMIT are attached to the terminal branch
  // AST, so they are hoisted to the compound root before branches run.
  const compoundAsts: Raw[] = []
  let cursor: Raw = ast
  while (cursor != null) {
    compoundAsts.push(cursor)
    cursor = cursor._next
  }

  if (compoundAsts.length > 1) {
    const operators: SetOperator[] = []
    for (let index = 0; index < compoundAsts.length - 1; index++) {
      const rawOperator = String(compoundAsts[index]?.set_op ?? '').toLowerCase()
      if (rawOperator === 'union distinct') {
        unsupportedReasons.push(
          'UNION DISTINCT is not supported by SQLite; UNION already removes duplicates.',
        )
        return null
      }
      const operator = SET_OPERATORS[rawOperator]
      if (operator === undefined) {
        unsupportedReasons.push(
          `Only UNION, UNION ALL, INTERSECT and EXCEPT compound selects are visualizable; "${rawOperator.toUpperCase()}" is not supported.`,
        )
        return null
      }
      operators.push(operator)
    }

    const terminal: Raw = compoundAsts[compoundAsts.length - 1]
    const hoistedOrderBy = terminal?.orderby ?? null
    const hoistedLimit = terminal?.limit ?? null

    const branches: CompoundBranch[] = []
    for (let index = 0; index < compoundAsts.length; index++) {
      const branchAst: Raw = { ...(compoundAsts[index] as Raw) }
      // A branch is an independent SELECT block: it never owns the chain,
      // the root WITH clause, or the compound's trailing clauses.
      delete branchAst._next
      delete branchAst.previous
      delete branchAst.set_op
      delete branchAst.with
      branchAst.orderby = null
      branchAst.limit = null

      const branchContext: InterpretContext = {
        ...blockContext,
        parentStage: 'COMPOUND',
        collected: [],
        allowCtes: false,
      }
      const branchQuery = interpretSelectAst(branchAst, branchContext, 'compound')
      if (branchQuery === null) {
        unsupportedReasons.push(`Compound branch ${index + 1} could not be interpreted.`)
        return null
      }
      branches.push({
        query: branchQuery,
        operator: index === 0 ? null : (operators[index - 1] ?? 'UNION'),
      })
    }

    const orderBy = interpretOrderByList(
      hoistedOrderBy,
      clause('ORDER_BY'),
      unsupportedReasons,
      'Compound ORDER BY',
    )
    const limit = interpretLimitClause(hoistedLimit, clause('LIMIT'), unsupportedReasons)

    return {
      id,
      blockKind: context.blockId === null ? 'root' : (blockKind ?? 'scalar'),
      parentId: context.blockId,
      depth: context.depth,
      consumingStage: context.blockId === null ? null : context.parentStage,
      distinct: false,
      selectItems: [],
      selectAll: false,
      from: { name: '', alias: null },
      joins: [],
      where: null,
      groupBy: [],
      having: null,
      orderBy,
      limit,
      aggregates: [],
      ctes,
      subqueries,
      compound: { branches },
      statementType: 'SELECT',
    }
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
  /** Table qualifier for `table.*`, or null for a bare `*`. */
  const starQualifierOf = (expr: Raw): string | null => {
    if (expr?.type === 'star') {
      return typeof expr.table === 'string' && expr.table.length > 0 ? expr.table : null
    }
    if (expr?.type === 'column_ref' && columnNameOf(expr.column) === '*') {
      return typeof expr.table === 'string' && expr.table.length > 0 ? expr.table : null
    }
    return null
  }
  if (
    columnList.length === 1 &&
    isStarExpr(columnList[0]?.expr) &&
    columnList[0]?.as == null &&
    starQualifierOf(columnList[0]?.expr) === null
  ) {
    selectAll = true
  }

  // SQLite hides a table's original name once it has an alias: only the
  // alias can qualify its columns. Track the effective name per source.
  const sourceQualifiers = new Map<string, { name: string; alias: string | null }>()
  const addSourceQualifier = (name: string, alias: string | null): void => {
    sourceQualifiers.set((alias ?? name).toLowerCase(), { name, alias })
  }
  addSourceQualifier(from.name, from.alias)
  for (const join of joins) addSourceQualifier(join.table.name, join.table.alias)

  for (const item of columnList) {
    const expr = interpretExpression(item.expr, clause('SELECT'))
    if (expr === null) {
      unsupportedReasons.push(`SELECT expression "${textOfRaw(item.expr)}" is not visualizable yet.`)
      continue
    }
    if (
      expr.kind === 'star' &&
      expr.table !== null &&
      !sourceQualifiers.has(expr.table.toLowerCase())
    ) {
      const shadowed = [from, ...joins.map((join) => join.table)].find(
        (table) => table.alias !== null && table.name.toLowerCase() === expr.table?.toLowerCase(),
      )
      unsupportedReasons.push(
        shadowed !== null && shadowed !== undefined
          ? `Wildcard "${expr.table}.*" cannot use table name "${shadowed.name}" because it is aliased as "${shadowed.alias}". Use "${shadowed.alias}.*".`
          : `Wildcard "${expr.table}.*" does not match a table or alias in this query block.`,
      )
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

  const orderBy = interpretOrderByList(ast.orderby, clause('ORDER_BY'), unsupportedReasons, 'ORDER BY')
  const limit = interpretLimitClause(ast.limit, clause('LIMIT'), unsupportedReasons)

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
      case 'collate':
        collectAggregates(expr.operand)
        break
      case 'in_subquery':
        collectAggregates(expr.left)
        break
      case 'exists_subquery':
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
    compound: null,
    statementType: 'SELECT',
  }

  return structure
}

/** Unwrap the one-statement array returned for a trailing semicolon. */
function asSingleSelectAst(ast: Raw): Raw | null {
  const candidate = Array.isArray(ast) ? (ast.length === 1 ? ast[0] : null) : ast
  return candidate?.type === 'select' ? candidate : null
}

/**
 * Interpret a compound form that node-sql-parser cannot parse itself.
 * Branch SQL is parsed independently, then linked into the same AST shape
 * produced for UNION so the existing compound interpreter owns CTEs, IDs,
 * nested blocks and terminal-clause hoisting.
 */
function interpretCompoundFallback(
  outcome: CompoundSplitOutcome,
  context: InterpretContext,
): QueryStructure | null {
  if (!outcome.ok) {
    context.reasons.push(outcome.reason)
    return null
  }
  if (outcome.segments.length < 2) {
    context.reasons.push('A compound query needs at least two SELECT branches.')
    return null
  }

  const branchAsts: Raw[] = []
  for (const [index, segment] of outcome.segments.entries()) {
    const branchAst = asSingleSelectAst(parseSql(segment.sql))
    if (branchAst === null) {
      context.reasons.push(
        `Compound branch ${index + 1} could not be parsed as a single SELECT statement.`,
      )
      return null
    }
    if (index > 0 && branchAst.with != null) {
      context.reasons.push('WITH must precede the first branch of a compound query.')
      return null
    }
    branchAsts.push(branchAst)
  }

  // Parse the root clauses without changing the branch SQL. The terminal
  // AST owns these fields just as it does in node-sql-parser's UNION AST.
  const tail = [outcome.tail.orderBy, outcome.tail.limit]
    .filter((clause): clause is string => clause !== null)
    .join(' ')
  if (tail !== '') {
    const tailAst = asSingleSelectAst(parseSql(`SELECT 1 ${tail}`))
    if (tailAst === null) {
      context.reasons.push('The compound ORDER BY / LIMIT clauses could not be parsed.')
      return null
    }
    const terminal = branchAsts[branchAsts.length - 1] as Raw
    terminal.orderby = tailAst.orderby
    terminal.limit = tailAst.limit
  }

  for (let index = 0; index < branchAsts.length - 1; index++) {
    const operator = outcome.segments[index + 1]?.operator
    if (operator == null) {
      context.reasons.push(`Compound operator before branch ${index + 2} is missing.`)
      return null
    }
    const parserOperator = PARSER_SET_OPERATORS[operator]
    if (parserOperator === undefined) {
      context.reasons.push(`Compound operator "${operator}" is not supported.`)
      return null
    }
    const current = branchAsts[index] as Raw
    current.set_op = parserOperator
    current._next = branchAsts[index + 1]
  }

  return interpretSelectAst(branchAsts[0] as Raw, context)
}


/**
 * Interpret one SQL statement. Returns the structure plus the list of
 * unsupported constructs found. Never throws.
 */
export function interpretStatement(sql: string): InterpretationResult {
  const ast = asSingleSelectAst(parseSql(sql))
  if (ast !== null) {
    const context = createInterpretContext()
    const structure = interpretSelectAst(ast, context)
    if (structure === null && context.reasons.length === 0) {
      context.reasons.push('The query could not be interpreted.')
    }
    return { structure, unsupportedReasons: context.reasons }
  }

  // INTERSECT, EXCEPT and mixed chains are not accepted by the SQLite
  // grammar of node-sql-parser. Use the scanner only for those compound
  // forms; ordinary SELECT behavior and the existing UNION path stay intact.
  const compound = splitCompoundQuery(sql)
  if (compound !== null) {
    const context = createInterpretContext()
    const structure = interpretCompoundFallback(compound, context)
    if (structure === null && context.reasons.length === 0) {
      context.reasons.push('The compound query could not be interpreted.')
    }
    return { structure, unsupportedReasons: context.reasons }
  }

  const statementType = detectStatementType(sql)
  if (statementType !== 'SELECT') {
    return { structure: null, unsupportedReasons: ['Only SELECT queries can be visualized.'] }
  }
  return { structure: null, unsupportedReasons: ['The statement could not be parsed as a SELECT.'] }
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
