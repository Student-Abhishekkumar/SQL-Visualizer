import { Parser, type Parser as SqlParser } from 'node-sql-parser'
import type { StatementType } from '../../types/query'

/**
 * SQL parsing integration built on node-sql-parser.
 *
 * Parsing is strictly additive: it powers statement classification and
 * (in Stage 2) AST-based visualization. A parse failure NEVER blocks
 * execution — sqlite itself decides what is valid.
 */

let parser: SqlParser | null = null

function getParser(): SqlParser {
  if (!parser) {
    parser = new Parser()
  }
  return parser
}

/** Raw AST or null when the statement cannot be parsed as SQLite. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseSql(sql: string): any | null {
  if (!sql.trim()) return null
  try {
    return getParser().astify(sql, { database: 'sqlite' })
  } catch {
    return null
  }
}

/** Parse failure detail (node-sql-parser message) or null on success. */
export function getParseError(sql: string): string | null {
  try {
    getParser().astify(sql, { database: 'sqlite' })
    return null
  } catch (error) {
    return error instanceof Error ? error.message.replace(/^[\w.]+:\s*/, '') : String(error)
  }
}

/**
 * Classify a single statement. Uses the AST when available and falls
 * back to the first SQL keyword — never throws.
 */
export function detectStatementType(sql: string): StatementType {
  const ast = parseSql(sql)
  if (ast && typeof ast.type === 'string') {
    return normalizeTypeKeyword(ast.type)
  }
  // Strip comments before scanning for the leading keyword.
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const keyword = /\b([A-Za-z]+)/.exec(stripped)?.[1]
  return normalizeTypeKeyword(keyword ?? '')
}

function normalizeTypeKeyword(keyword: string): StatementType {
  const upper = keyword.trim().toUpperCase()
  const known: readonly StatementType[] = [
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
    'REPLACE', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK', 'VACUUM',
    'ANALYZE', 'EXPLAIN',
  ]
  return known.find((type) => type === upper) ?? 'UNKNOWN'
}

/** Statement types that change data or schema (relevant for persistence). */
const MUTATING_TYPES: ReadonlySet<StatementType> = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REPLACE', 'VACUUM',
])

export function isMutatingStatementType(type: StatementType): boolean {
  return MUTATING_TYPES.has(type)
}

/**
 * Table names referenced in a statement via FROM/JOIN clauses.
 * AST-based when parseable, regex fallback otherwise. Static analysis
 * only — the result is always real text from the query.
 */
export function getReferencedTables(sql: string): string[] {
  const ast = parseSql(sql)
  if (ast) {
    const names = new Set<string>()
    collectTablesFromAst(ast, names)
    if (names.size > 0) return [...names]
  }
  const matches = sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)/gi)
  return [...new Set([...matches].map((match) => match[1] ?? '').filter(Boolean))]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectTablesFromAst(node: any, names: Set<string>): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectTablesFromAst(item, names)
    return
  }
  // node-sql-parser table nodes look like { type: 'table', table: [{ db, table }] }
  const tableList = node.table
  if (node.type === 'table' && Array.isArray(tableList)) {
    for (const entry of tableList) {
      const name = typeof entry === 'string' ? entry : entry?.table
      if (typeof name === 'string') names.add(name)
    }
  }
  for (const value of Object.values(node)) collectTablesFromAst(value, names)
}
