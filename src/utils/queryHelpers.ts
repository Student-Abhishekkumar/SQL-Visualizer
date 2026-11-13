/**
 * Query text utilities used by the execution engine and UI.
 */

/**
 * Split a SQL batch into individual statements on top-level semicolons.
 * Respects string literals (single, double, backtick), bracket
 * identifiers, escaped quotes, and dash or block comments, so a
 * semicolon inside any of them never splits statements.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i] as string

    if (quote !== null) {
      current += ch
      if (quote === '[') {
        if (ch === ']') quote = null
      } else if (ch === quote) {
        if (sql[i + 1] === quote) {
          // Escaped quote ('' inside a string literal).
          current += sql[i + 1]
          i++
        } else {
          quote = null
        }
      }
      i++
      continue
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? n : end
      current += sql.slice(i, stop)
      i = stop
      continue
    }

    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      current += sql.slice(i, stop)
      i = stop
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch
      current += ch
      i++
      continue
    }

    if (ch === ';') {
      statements.push(current)
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  statements.push(current)

  return statements
    .map((statement) => statement.trim())
    .filter(hasExecutableContent)
}

/** True when text contains real SQL content beyond whitespace/comments. */
export function hasExecutableContent(text: string): boolean {
  const stripped = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
  return stripped.length > 0
}

/** Collapse all whitespace runs (including newlines) to single spaces. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Count statements without executing anything. */
export function countStatements(sql: string): number {
  return splitStatements(sql).length
}
