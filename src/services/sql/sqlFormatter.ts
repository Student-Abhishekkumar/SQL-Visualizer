import { normalizeWhitespace } from '../../utils/queryHelpers'

/**
 * Lightweight SQL pretty-printer.
 *
 * Formats by clause keywords rather than a full parse, which keeps it
 * robust across the whole SQLite grammar (it never fails on valid
 * input). String literals, quoted identifiers and comments are
 * preserved verbatim; identifiers keep their original casing.
 */

interface Piece {
  text: string
  /** Literals pass through untouched and never match keywords. */
  literal: boolean
}

/** Keywords that begin a new line at paren depth 0, longest-first. */
const BREAK_KEYWORDS = [
  'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
  'SELECT DISTINCT', 'SELECT',
  'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'WINDOW',
  'ORDER BY', 'LIMIT', 'OFFSET',
  'LEFT OUTER JOIN', 'LEFT JOIN', 'RIGHT OUTER JOIN', 'RIGHT JOIN',
  'FULL OUTER JOIN', 'FULL JOIN', 'CROSS JOIN', 'NATURAL JOIN',
  'INNER JOIN', 'OUTER JOIN', 'JOIN',
  'ON', 'USING', 'VALUES', 'SET',
]

/** Break keywords whose continuation lines are indented one level. */
const INDENTED_KEYWORDS = new Set(['ON', 'USING'])

/** Standalone words rendered in uppercase (never part of identifiers). */
const UPPERCASE_WORDS = new Set([
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'AS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS',
  'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'ALL',
  'BY', 'TO', 'INTO', 'TABLE', 'IF', 'TRUE', 'FALSE', 'ADD', 'COLUMN',
  'CONSTRAINT', 'KEY', 'FOREIGN', 'REFERENCES', 'PRIMARY', 'UNIQUE',
  'DEFAULT', 'CHECK', 'CASCADE', 'RESTRICT', 'ACTION', 'NO', 'NULLS',
  'FIRST', 'LAST', 'OVER', 'PARTITION', 'ROWS', 'RANGE', 'PRECEDING',
  'FOLLOWING', 'CURRENT', 'ROW', 'WITH', 'RECURSIVE', 'ATTACH', 'DETACH',
  'DATABASE', 'COLLATE', 'AUTOINCREMENT', 'TEMP', 'TEMPORARY', 'VIEW',
  'INDEX', 'TRIGGER', 'ON', 'CONFLICT', 'ABORT', 'FAIL', 'IGNORE',
  'ROLLBACK', 'TRANSACTION', 'BEGIN', 'COMMIT', 'REINDEX', 'RENAME',
])

/** Function names whose '(' attaches without a space. */
const FUNCTION_NAMES = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'TOTAL', 'GROUP_CONCAT', 'ROUND',
  'ABS', 'UPPER', 'LOWER', 'LENGTH', 'SUBSTR', 'TRIM', 'REPLACE', 'INSTR',
  'COALESCE', 'IFNULL', 'NULLIF', 'CAST', 'PRINTF', 'HEX', 'RANDOM',
  'DATE', 'TIME', 'DATETIME', 'JULIANDAY', 'STRFTIME', 'TYPEOF', 'IIF',
  'JSON', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'SQLITE_VERSION',
])

/** Keywords after which AND/OR/OR-style connectors go on their own line. */
const CONNECTOR_SECTIONS = new Set(['WHERE', 'HAVING', 'ON'])

function tokenizeSQL(sql: string): Piece[] {
  const pieces: Piece[] = []
  let i = 0
  let plain = ''

  const flush = () => {
    if (plain.trim()) pieces.push({ text: plain, literal: false })
    plain = ''
  }

  while (i < sql.length) {
    const ch = sql[i] as string

    if (ch === '-' && sql[i + 1] === '-') {
      flush()
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      pieces.push({ text: sql.slice(i, stop), literal: true })
      i = stop
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      flush()
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      pieces.push({ text: sql.slice(i, stop), literal: true })
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      flush()
      const start = i
      const closer = ch === '[' ? ']' : ch
      i++
      while (i < sql.length) {
        if (sql[i] === closer) {
          if (closer !== ']' && sql[i + 1] === closer) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      pieces.push({ text: sql.slice(start, i), literal: true })
      continue
    }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j] as string)) j++
      flush()
      pieces.push({ text: sql.slice(i, j), literal: false })
      i = j
      continue
    }

    // Whitespace is dropped; every punctuation character becomes its
    // own piece so spacing decisions stay localized.
    if (/\s/.test(ch)) {
      flush()
      i++
      continue
    }
    flush()
    pieces.push({ text: ch, literal: false })
    i++
  }
  flush()
  return pieces
}

/**
 * Pretty-print a SQL string. Never throws on unusual input; input that
 * cannot be improved is returned essentially unchanged.
 */
export function formatSQL(sql: string): string {
  if (!sql.trim()) return sql
  const pieces = tokenizeSQL(sql)

  const lines: string[] = []
  let line = ''
  let depth = 0
  let lastBreakKeyword = ''

  const pushLine = () => {
    if (line.trim()) lines.push(line.trimEnd())
  }
  /** Indent used for continuation lines of the current section. */
  const sectionIndent = () =>
    lastBreakKeyword === 'SELECT' || INDENTED_KEYWORDS.has(lastBreakKeyword)
      ? '  '
      : ''

  let prevPieceUpper = ''

  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] as Piece
    const text = piece.text

    if (piece.literal) {
      // Literals attach without an extra space when they open a line.
      if (line && !line.endsWith(' ') && !line.endsWith('(') && !line.endsWith('.')) {
        line += ' '
      }
      line += text
      prevPieceUpper = ''
      continue
    }

    // Parenthesis rendering (attached; spacing handled by neighbors).
    if (text === '(') {
      if (line && !FUNCTION_NAMES.has(prevPieceUpper) && !line.endsWith(' ')) {
        line += ' '
      }
      line += '('
      depth++
      prevPieceUpper = ''
      continue
    }
    if (text === ')') {
      depth = Math.max(0, depth - 1)
      line += ')'
      prevPieceUpper = ''
      continue
    }

    if (text === ',') {
      line += ','
      if (depth === 0) {
        pushLine()
        line = sectionIndent()
      }
      prevPieceUpper = ''
      continue
    }

    if (text === ';') {
      line += ';'
      pushLine()
      line = ''
      lastBreakKeyword = ''
      prevPieceUpper = ''
      continue
    }

    const isWord = /^[A-Za-z0-9_$]+$/.test(text)
    if (!isWord) {
      if (text === '.') {
        line += '.'
        prevPieceUpper = ''
        continue
      }
      // Operators: spaced on both sides. Everything else attaches.
      if (line && !line.endsWith(' ') && !line.endsWith('(')) line += ' '
      line += text
      prevPieceUpper = ''
      continue
    }

    const upper = text.toUpperCase()

    // Multi-word or single-word break keyword?
    if (depth === 0) {
      const breakKeyword = matchBreakKeyword(pieces, i)
      if (breakKeyword) {
        pushLine()
        line =
          (INDENTED_KEYWORDS.has(breakKeyword) ? '  ' : '') + breakKeyword
        lastBreakKeyword = breakKeyword.split(' ')[0] ?? ''
        i += breakKeyword.split(' ').length - 1
        prevPieceUpper = ''
        continue
      }
      if ((upper === 'AND' || upper === 'OR') && CONNECTOR_SECTIONS.has(lastBreakKeyword)) {
        pushLine()
        line = '  ' + upper
        prevPieceUpper = upper
        continue
      }
    }

    // Render the word with correct casing.
    const rendered =
      UPPERCASE_WORDS.has(upper) ||
      BREAK_KEYWORDS.includes(upper) ||
      FUNCTION_NAMES.has(upper)
        ? upper
        : text

    const prevChar = line.length > 0 ? (line[line.length - 1] as string) : ''
    const needsSpace =
      prevChar !== '' &&
      prevChar !== '(' &&
      prevChar !== '.' &&
      line.trim() !== ''
    line += (needsSpace ? ' ' : '') + rendered
    prevPieceUpper = rendered.toUpperCase()
  }
  pushLine()

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** Longest break keyword starting at piece index, or null. */
function matchBreakKeyword(
  pieces: Piece[],
  index: number,
): string | null {
  for (const keyword of BREAK_KEYWORDS) {
    const parts = keyword.split(' ')
    let ok = true
    for (let k = 0; k < parts.length; k++) {
      const piece = pieces[index + k]
      if (!piece || piece.literal) {
        ok = false
        break
      }
      if ((piece.text as string).toUpperCase() !== parts[k]) {
        ok = false
        break
      }
    }
    if (ok) return keyword
  }
  return null
}

/** Trim and collapse a query for compact display (history lists, etc.). */
export function summarizeSQL(sql: string, maxLength = 64): string {
  const flat = normalizeWhitespace(sql)
  if (flat.length <= maxLength) return flat
  return flat.slice(0, maxLength - 1).trimEnd() + '…'
}
