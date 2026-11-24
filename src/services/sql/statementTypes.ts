import type { StatementType } from '../../types/query'

/**
 * Dependency-free SQL statement classification.
 *
 * The full AST parser (`node-sql-parser`, ~250 kB with its big-integer
 * dependency) is only needed by the visualization engine, which is loaded
 * on demand. Database execution, persistence and the result panels only
 * need a statement's leading keyword, so they use this lightweight
 * classifier instead of pulling the parser into the initial bundle.
 */

const KNOWN_TYPES: readonly StatementType[] = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER',
  'REPLACE', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK', 'VACUUM',
  'ANALYZE', 'EXPLAIN',
]

/** Statement types that change data or schema (relevant for persistence). */
const MUTATING_TYPES: ReadonlySet<StatementType> = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'REPLACE', 'VACUUM',
])

/** Data-changing statements whose rows-modified count is meaningful. */
export function isMutatingStatementType(type: StatementType): boolean {
  return MUTATING_TYPES.has(type)
}

function normalizeTypeKeyword(keyword: string): StatementType {
  const upper = keyword.trim().toUpperCase()
  return KNOWN_TYPES.find((type) => type === upper) ?? 'UNKNOWN'
}

/** Remove line and block comments, preserving string literals. */
function stripComments(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    const next = sql[index + 1]
    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        index += 1
      }
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < sql.length) {
        out += sql[index]
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            out += sql[index + 1]
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * First DML keyword at parenthesis depth 0. This is what distinguishes the
 * real statement in a `WITH … SELECT/INSERT/UPDATE/DELETE` CTE query from
 * the SELECTs inside its CTE bodies.
 */
function firstTopLevelDml(sql: string): StatementType {
  const dml = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'])
  let depth = 0
  let index = 0
  while (index < sql.length) {
    const char = sql[index] as string
    if (char === '(') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (depth === 0 && /[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] as string)) end += 1
      const word = sql.slice(index, end).toUpperCase()
      if (dml.has(word)) return normalizeTypeKeyword(word)
      index = end
      continue
    }
    index += 1
  }
  return 'UNKNOWN'
}

/**
 * Classify a single statement. Uses the leading keyword and, for CTE
 * queries, the first top-level DML keyword. Never throws.
 */
export function classifyStatementType(sql: string): StatementType {
  const stripped = stripComments(sql).trim()
  if (stripped === '') return 'UNKNOWN'
  const match = /^([A-Za-z]+)/.exec(stripped)
  const keyword = match?.[1] ?? ''
  const upper = keyword.toUpperCase()
  if (upper === 'WITH') return firstTopLevelDml(stripped)
  // EXPLAIN prefixes the statement it explains.
  if (upper === 'EXPLAIN') {
    const rest = stripped.replace(/^EXPLAIN\b/i, '').replace(/^QUERY\s+PLAN\b/i, '').trim()
    return rest === '' ? 'EXPLAIN' : classifyStatementType(rest)
  }
  return normalizeTypeKeyword(keyword)
}