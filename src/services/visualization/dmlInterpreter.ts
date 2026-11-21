import { detectStatementType, parseSql } from '../sql/sqlParser'
import { interpretExpression, type Expression } from './astInterpreter'

/** Conservative, explicitly classified DML accepted by the preview executor. */
export type SupportedDml =
  | {
      kind: 'INSERT'
      sql: string
      table: string
      columns: string[] | null
      input:
        | { kind: 'VALUES'; rows: Expression[][] }
        | { kind: 'SELECT'; sql: string }
        | { kind: 'DEFAULT VALUES' }
    }
  | {
      kind: 'UPDATE'
      sql: string
      table: string
      assignments: Array<{ column: string; expression: Expression }>
      where: Expression | null
    }
  | { kind: 'DELETE'; sql: string; table: string; where: Expression | null }

export type DmlInterpretation =
  | { supported: true; statement: SupportedDml }
  | { supported: false; reasons: string[] }

// The parser's DML AST is only partially typed. This boundary keeps the
// unchecked payload out of the typed simulator.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any

function parserMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return `The DML statement could not be parsed as supported SQLite syntax. ${error.message.split('\n')[0] ?? ''}`
}

function unsupported(reason: string): DmlInterpretation {
  return { supported: false, reasons: [reason] }
}

function expression(raw: Raw, label: string): { value: Expression } | { reasons: string[] } {
  const interpreted = interpretExpression(raw)
  if (interpreted === null) {
    return { reasons: [`${label} is not visualizable. Use literals, target-table columns, supported COLLATE, arithmetic, comparisons, AND/OR/NOT, IN lists, BETWEEN, IS, or LIKE.`] }
  }
  if (containsRowUnsupportedExpression(interpreted)) {
    return { reasons: [`${label} cannot contain subqueries, aggregates, wildcards, or a bare value list in a DML preview.`] }
  }
  return { value: interpreted }
}

function containsRowUnsupportedExpression(expr: Expression): boolean {
  switch (expr.kind) {
    case 'subquery': case 'in_subquery': case 'exists_subquery':
    case 'aggregate': case 'star': case 'list':
      return true
    case 'comparison':
      if ((expr.operator === 'IN' || expr.operator === 'NOT IN' || expr.operator === 'BETWEEN' || expr.operator === 'NOT BETWEEN') && expr.right.kind === 'list') {
        return containsRowUnsupportedExpression(expr.left) || expr.right.exprs.some(containsRowUnsupportedExpression)
      }
      return containsRowUnsupportedExpression(expr.left) || containsRowUnsupportedExpression(expr.right)
    case 'logical': case 'arithmetic':
      return containsRowUnsupportedExpression(expr.left) || containsRowUnsupportedExpression(expr.right)
    case 'not': case 'unary_minus': case 'collate':
      return containsRowUnsupportedExpression(expr.operand)
    default:
      return false
  }
}

function singleTable(raw: Raw, operation: string): string | { reasons: string[] } {
  if (!Array.isArray(raw) || raw.length !== 1) return { reasons: [`${operation} preview requires exactly one target table.`] }
  const table = raw[0]
  if (typeof table?.table !== 'string' || table.db != null || table.as != null) {
    return { reasons: [`${operation} preview supports one unaliased table in the main database only.`] }
  }
  return table.table
}

function hasUniqueColumns(columns: readonly string[]): boolean {
  return new Set(columns.map((column) => column.toLowerCase())).size === columns.length
}

function interpretDefaultValues(sql: string): DmlInterpretation | null {
  const match = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_$]*)\s+DEFAULT\s+VALUES\s*;?\s*$/i.exec(sql)
  if (match === null) return null
  return { supported: true, statement: { kind: 'INSERT', sql, table: match[1] as string, columns: null, input: { kind: 'DEFAULT VALUES' } } }
}

/** Preserve the user's source SELECT instead of re-quoting it through sqlify. */
function sourceSelectSql(sql: string): string | null {
  let depth = 0
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) {
      const end = char === '-' ? sql.indexOf('\n', index + 2) : sql.indexOf('*/', index + 2)
      index = end < 0 ? sql.length : end + (char === '-' ? 1 : 2)
      continue
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      index += 1
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close) index += 2
        else if (sql[index] === close) { index += 1; break }
        else index += 1
      }
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /^select$/i.test(sql.slice(index, index + 6))) {
      const before = sql[index - 1]
      const after = sql[index + 6]
      if ((before === undefined || !/[\w$]/.test(before)) && (after === undefined || !/[\w$]/.test(after))) {
        return sql.slice(index).trim().replace(/;\s*$/, '')
      }
    }
    index += 1
  }
  return null
}

/** Parse and classify the only DML forms allowed to enter isolated execution. */
export function interpretDml(statements: string[]): DmlInterpretation {
  if (statements.length === 0) return unsupported('There is no SQL statement to visualize.')
  if (statements.length > 1) return unsupported('Multiple statements are not visualizable. Write one INSERT, UPDATE, DELETE, or SELECT statement.')
  const statement = statements[0] as string
  const type = detectStatementType(statement)
  if (type !== 'INSERT' && type !== 'UPDATE' && type !== 'DELETE') return unsupported('Only SELECT and supported INSERT, UPDATE, or DELETE statements can be visualized.')
  const defaultValues = type === 'INSERT' ? interpretDefaultValues(statement) : null
  if (defaultValues !== null) return defaultValues
  let ast: Raw
  try {
    const parsed = parseSql(statement)
    ast = Array.isArray(parsed) ? parsed[0] : parsed
  } catch (error) {
    return unsupported(parserMessage(error))
  }
  if (ast == null || String(ast.type).toLowerCase() !== type.toLowerCase()) return unsupported(`The statement could not be parsed as ${type}.`)
  if (ast.returning != null) return unsupported('RETURNING is not supported in DML visualization; the preview shows affected rows and the final table itself.')
  if (ast.with != null) return unsupported('WITH clauses attached directly to DML are not supported yet.')
  if (ast.orderby != null || ast.limit != null) return unsupported('ORDER BY and LIMIT on DML are not supported in visualization.')

  if (type === 'INSERT') {
    if (ast.or != null || String(ast.prefix ?? 'into').toLowerCase() !== 'into' || ast.on_duplicate_update != null || (Array.isArray(ast.partition) && ast.partition.length > 0)) {
      return unsupported('INSERT conflict clauses, UPSERT, REPLACE, and partitioning are not supported in visualization.')
    }
    const table = singleTable(ast.table, 'INSERT')
    if (typeof table !== 'string') return { supported: false, reasons: table.reasons }
    const columns = ast.columns == null ? null : (ast.columns as unknown[]).map(String)
    if (columns !== null && (columns.length === 0 || !hasUniqueColumns(columns))) return unsupported('INSERT column lists must be non-empty and contain no duplicate columns.')
    if (ast.values?.type === 'values' && Array.isArray(ast.values.values)) {
      const rows: Expression[][] = []
      for (const [rowIndex, rawRow] of (ast.values.values as Raw[]).entries()) {
        if (rawRow?.type !== 'expr_list' || !Array.isArray(rawRow.value)) return unsupported(`INSERT VALUES row ${rowIndex + 1} could not be interpreted.`)
        const row: Expression[] = []
        for (const [valueIndex, rawValue] of (rawRow.value as Raw[]).entries()) {
          const converted = expression(rawValue, `INSERT VALUES row ${rowIndex + 1}, value ${valueIndex + 1}`)
          if ('reasons' in converted) return { supported: false, reasons: converted.reasons }
          row.push(converted.value)
        }
        rows.push(row)
      }
      return { supported: true, statement: { kind: 'INSERT', sql: statement, table, columns, input: { kind: 'VALUES', rows } } }
    }
    if (ast.values?.type === 'select') {
      const sourceSql = sourceSelectSql(statement)
      if (sourceSql === null) return unsupported('The INSERT source SELECT could not be located in the original SQL.')
      return { supported: true, statement: { kind: 'INSERT', sql: statement, table, columns, input: { kind: 'SELECT', sql: sourceSql } } }
    }
    return unsupported('Only INSERT … VALUES, INSERT … SELECT, and INSERT … DEFAULT VALUES are visualizable.')
  }

  const table = singleTable(type === 'UPDATE' ? ast.table : ast.from, type)
  if (typeof table !== 'string') return { supported: false, reasons: table.reasons }
  if (type === 'DELETE') {
    if (!Array.isArray(ast.table) || ast.table.length !== 1 || ast.table[0]?.table !== table) return unsupported('DELETE preview supports only DELETE FROM one table, without joins or USING.')
    const where = ast.where == null ? { value: null } : expression(ast.where, 'DELETE WHERE')
    if ('reasons' in where) return { supported: false, reasons: where.reasons }
    return { supported: true, statement: { kind: 'DELETE', sql: statement, table, where: where.value } }
  }

  if (!Array.isArray(ast.set) || ast.set.length === 0) return unsupported('UPDATE preview requires at least one SET assignment.')
  const assignments: Array<{ column: string; expression: Expression }> = []
  for (const rawAssignment of ast.set as Raw[]) {
    const column = String(rawAssignment?.column ?? '')
    if (column === '' || rawAssignment?.table != null) return unsupported('UPDATE SET targets must be unqualified column names.')
    const converted = expression(rawAssignment.value, `UPDATE SET ${column}`)
    if ('reasons' in converted) return { supported: false, reasons: converted.reasons }
    assignments.push({ column, expression: converted.value })
  }
  if (!hasUniqueColumns(assignments.map((assignment) => assignment.column))) return unsupported('UPDATE SET must not assign the same column more than once.')
  const where = ast.where == null ? { value: null } : expression(ast.where, 'UPDATE WHERE')
  if ('reasons' in where) return { supported: false, reasons: where.reasons }
  return { supported: true, statement: { kind: 'UPDATE', sql: statement, table, assignments, where: where.value } }
}
