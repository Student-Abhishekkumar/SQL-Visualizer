import { detectStatementType, getParseError, parseSql } from '../sql/sqlParser'

/** Conservative DDL forms accepted by the isolated schema preview. */
export type SupportedDdl =
  | { operation: 'CREATE_TABLE'; sql: string; table: string; ifNotExists: boolean }
  | {
      operation: 'ALTER_TABLE'
      sql: string
      table: string
      action:
        | { kind: 'RENAME_TABLE'; newTable: string }
        | { kind: 'RENAME_COLUMN'; oldColumn: string; newColumn: string }
        | { kind: 'ADD_COLUMN'; column: string }
        | { kind: 'DROP_COLUMN'; column: string }
    }
  | { operation: 'DROP_TABLE'; sql: string; table: string; ifExists: boolean }
  | {
      operation: 'CREATE_INDEX'
      sql: string
      index: string
      table: string
      unique: boolean
      ifNotExists: boolean
    }
  | { operation: 'DROP_INDEX'; sql: string; index: string; ifExists: boolean }

export type DdlInterpretation =
  | { supported: true; statement: SupportedDdl }
  | { supported: false; reasons: string[] }

// node-sql-parser's DDL AST is not fully typed. Keep that boundary here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any

function unsupported(reason: string): DdlInterpretation {
  return { supported: false, reasons: [reason] }
}

function columnName(raw: Raw): string | null {
  const value = raw?.column
  if (typeof value === 'string') return value
  if (typeof value?.column === 'string') return value.column
  return null
}

function mainTable(raw: Raw, operation: string): string | { error: string } {
  const table = Array.isArray(raw) ? raw[0] : raw
  if ((Array.isArray(raw) && raw.length !== 1) || typeof table?.table !== 'string') {
    return { error: `${operation} preview requires exactly one table.` }
  }
  if (table.db != null || table.as != null) {
    return { error: `${operation} preview supports one unaliased table in the main database only.` }
  }
  return table.table
}

/**
 * Parse DROP INDEX directly. node-sql-parser 5.4 rejects this SQLite form,
 * including the optional IF EXISTS. This small lexer intentionally accepts
 * nothing else; quoted identifiers and comments remain supported.
 */
function interpretDropIndex(sql: string): DdlInterpretation | null {
  let offset = 0
  const skip = (): void => {
    while (offset < sql.length) {
      const rest = sql.slice(offset)
      const whitespace = /^\s+/.exec(rest)
      if (whitespace !== null) {
        offset += whitespace[0].length
        continue
      }
      if (rest.startsWith('--')) {
        const end = sql.indexOf('\n', offset + 2)
        offset = end < 0 ? sql.length : end + 1
        continue
      }
      if (rest.startsWith('/*')) {
        const end = sql.indexOf('*/', offset + 2)
        if (end < 0) {
          offset = sql.length
          return
        }
        offset = end + 2
        continue
      }
      break
    }
  }
  const identifier = (): string | null => {
    skip()
    const first = sql[offset]
    if (first === undefined) return null
    if (first === '"' || first === '`' || first === '[') {
      const close = first === '[' ? ']' : first
      offset += 1
      let value = ''
      while (offset < sql.length) {
        const char = sql[offset] as string
        if (char === close) {
          if (sql[offset + 1] === close) {
            value += close
            offset += 2
            continue
          }
          offset += 1
          return value
        }
        value += char
        offset += 1
      }
      return null
    }
    const match = /^[A-Za-z0-9_$\u0080-\uFFFF]+/.exec(sql.slice(offset))
    if (match === null) return null
    offset += match[0].length
    return match[0]
  }
  const keyword = (expected: string): boolean => {
    const start = offset
    const value = identifier()
    if (value?.toUpperCase() === expected) return true
    offset = start
    return false
  }

  if (!keyword('DROP')) return null
  if (!keyword('INDEX')) return null
  const ifExists = keyword('IF')
  if (ifExists && !keyword('EXISTS')) return unsupported('Malformed DROP INDEX IF EXISTS clause.')
  const index = identifier()
  if (index === null || index === '') return unsupported('DROP INDEX requires an index name.')
  skip()
  if (sql[offset] === '.') return unsupported('DROP INDEX preview supports indexes in the main database only.')
  if (sql[offset] === ';') {
    offset += 1
    skip()
  }
  if (offset !== sql.length) return unsupported('DROP INDEX preview accepts only one index name and optional IF EXISTS.')
  return { supported: true, statement: { operation: 'DROP_INDEX', sql, index, ifExists } }
}

/** Parse and classify the only DDL forms allowed to enter isolated execution. */
export function interpretDdl(statements: string[]): DdlInterpretation {
  if (statements.length === 0) return unsupported('There is no SQL statement to visualize.')
  if (statements.length > 1) {
    return unsupported('Multiple statements are not visualizable. Write one supported DDL statement.')
  }
  const sql = statements[0] as string
  const type = detectStatementType(sql)
  if (type !== 'CREATE' && type !== 'ALTER' && type !== 'DROP') {
    return unsupported('Only SELECT, supported DML, and supported DDL statements can be visualized.')
  }

  const dropIndex = type === 'DROP' ? interpretDropIndex(sql) : null
  if (dropIndex !== null) return dropIndex

  const parsed = parseSql(sql)
  if (Array.isArray(parsed) && parsed.length !== 1) {
    return unsupported('Multiple statements are not visualizable. Write one supported DDL statement.')
  }
  const ast: Raw = Array.isArray(parsed) ? parsed[0] : parsed
  if (ast == null) {
    const detail = getParseError(sql)?.split('\n')[0]
    return unsupported(`The DDL statement could not be parsed as supported SQLite syntax.${detail ? ` ${detail}` : ''}`)
  }

  if (type === 'CREATE' && String(ast.keyword).toLowerCase() === 'table') {
    if (ast.temporary != null) return unsupported('Temporary tables are not supported in DDL visualization.')
    const table = mainTable(ast.table, 'CREATE TABLE')
    if (typeof table !== 'string') return unsupported(table.error)
    if (ast.as != null || ast.query_expr != null || !Array.isArray(ast.create_definitions) || ast.create_definitions.length === 0) {
      return unsupported('CREATE TABLE preview requires explicit column definitions; CREATE TABLE AS SELECT is not supported.')
    }
    return {
      supported: true,
      statement: { operation: 'CREATE_TABLE', sql, table, ifNotExists: ast.if_not_exists != null },
    }
  }

  if (type === 'CREATE' && String(ast.keyword).toLowerCase() === 'index') {
    const table = mainTable(ast.table, 'CREATE INDEX')
    if (typeof table !== 'string') return unsupported(table.error)
    const index = ast.index?.name
    if (typeof index !== 'string' || index === '' || ast.index?.schema != null) {
      return unsupported('CREATE INDEX preview requires an unqualified index name in the main database.')
    }
    if (!Array.isArray(ast.index_columns) || ast.index_columns.length === 0) {
      return unsupported('CREATE INDEX preview requires at least one indexed column or expression.')
    }
    return {
      supported: true,
      statement: {
        operation: 'CREATE_INDEX', sql, table, index,
        unique: String(ast.index_type ?? '').toLowerCase() === 'unique',
        ifNotExists: ast.if_not_exists != null,
      },
    }
  }

  if (type === 'DROP' && String(ast.keyword).toLowerCase() === 'table') {
    const table = mainTable(ast.name, 'DROP TABLE')
    if (typeof table !== 'string') return unsupported(table.error)
    return {
      supported: true,
      statement: { operation: 'DROP_TABLE', sql, table, ifExists: ast.prefix != null },
    }
  }


  if (type === 'ALTER') {
    const table = mainTable(ast.table, 'ALTER TABLE')
    if (typeof table !== 'string') return unsupported(table.error)
    if (!Array.isArray(ast.expr) || ast.expr.length !== 1) {
      return unsupported('ALTER TABLE preview supports exactly one operation per statement.')
    }
    const expression = ast.expr[0]
    const action = String(expression?.action ?? '').toLowerCase()
    const resource = String(expression?.resource ?? '').toLowerCase()
    if (action === 'rename' && resource === 'table' && typeof expression.table === 'string') {
      return { supported: true, statement: { operation: 'ALTER_TABLE', sql, table, action: { kind: 'RENAME_TABLE', newTable: expression.table } } }
    }
    if (action === 'rename' && resource === 'column') {
      const oldColumn = columnName(expression.old_column)
      const newColumn = columnName(expression.column)
      if (oldColumn !== null && newColumn !== null) {
        return { supported: true, statement: { operation: 'ALTER_TABLE', sql, table, action: { kind: 'RENAME_COLUMN', oldColumn, newColumn } } }
      }
    }
    if ((action === 'add' || action === 'drop') && resource === 'column') {
      const column = columnName(expression.column)
      if (column !== null && expression.definition !== null) {
        return {
          supported: true,
          statement: {
            operation: 'ALTER_TABLE', sql, table,
            action: { kind: action === 'add' ? 'ADD_COLUMN' : 'DROP_COLUMN', column },
          },
        }
      }
    }
    return unsupported('ALTER TABLE preview supports RENAME TO, RENAME COLUMN, ADD COLUMN, and DROP COLUMN only.')
  }

  return unsupported('Only CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX, and DROP INDEX are visualizable DDL statements.')
}
