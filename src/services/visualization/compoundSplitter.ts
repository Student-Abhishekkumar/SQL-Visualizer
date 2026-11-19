/**
 * Compound-query splitter.
 *
 * Recognizes the top-level set operators SQLite supports — `UNION`,
 * `UNION ALL`, `INTERSECT` and `EXCEPT` — without rewriting the SQL.
 * A character-by-character scanner tracks string and identifier quoting,
 * comments and parenthesis depth, so operator-like text inside any of
 * those never splits the statement.
 *
 * Stage 1 only: this module describes the original branch text and the
 * trailing compound clauses. It does not parse, interpret or simulate
 * anything, and it never changes the SQL it returns.
 *
 * SQLite constraints enforced here:
 * - `INTERSECT ALL`, `EXCEPT ALL` and `UNION DISTINCT` are not SQLite
 *   syntax and are rejected explicitly.
 * - `ORDER BY`, `LIMIT` and `OFFSET` belong to the whole compound query
 *   and must follow the final set operator.
 * - Parenthesized set-operation branches are not supported by SQLite.
 */

import { hasExecutableContent } from '../../utils/queryHelpers'

/** Set operators this splitter understands. */
export type CompoundOperator = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT'

/** One branch of a compound query, in evaluation order. */
export interface CompoundSegment {
  /** Original branch SQL, without the trailing compound clauses. */
  sql: string
  /** Operator joining this branch to the previous one; null for the first. */
  operator: CompoundOperator | null
}

/** Clauses that apply to the compound result as a whole. */
export interface CompoundTail {
  /** Root-level `ORDER BY …` text (inclusive), or null. */
  orderBy: string | null
  /** Root-level `LIMIT … [OFFSET …]` text (inclusive), or null. */
  limit: string | null
}

export interface CompoundSplit {
  segments: CompoundSegment[]
  tail: CompoundTail
}

/**
 * Result of a split.
 *
 * `null` (from `splitCompoundQuery`) means the statement has no top-level
 * set operator. `{ ok: false }` means a compound form was present but is
 * unsupported or malformed, so the caller must not guess.
 */
export type CompoundSplitOutcome =
  | ({ ok: true } & CompoundSplit)
  | { ok: false; reason: string }

interface OperatorMark {
  operator: CompoundOperator
  start: number
  end: number
}

type ClauseKind = 'ORDER_BY' | 'LIMIT' | 'OFFSET'

interface ClauseMark {
  kind: ClauseKind
  start: number
}

interface ScanResult {
  operators: OperatorMark[]
  clauses: ClauseMark[]
  /** True when a set-operator keyword was seen at the top level. */
  operatorLike: boolean
  /** True when one was seen inside parentheses (CTE body, subquery, …). */
  nestedOperatorLike: boolean
  /** First lexical or compound-level problem found, if any. */
  malformed: string | null
}

/** True for the keywords that can join two compound branches. */
function isSetOperatorKeyword(word: string): word is CompoundOperator {
  return word === 'UNION' || word === 'INTERSECT' || word === 'EXCEPT'
}

function isWordStart(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_'
  )
}

function isWordPart(ch: string): boolean {
  return isWordStart(ch) || (ch >= '0' && ch <= '9') || ch === '$'
}

function wordEnd(sql: string, start: number): number {
  let index = start
  while (index < sql.length && isWordPart(sql[index] as string)) index++
  return index
}

/** Uppercase word starting at `start`, or '' when there is none. */
function wordAt(sql: string, start: number): string {
  if (start >= sql.length || !isWordStart(sql[start] as string)) return ''
  return sql.slice(start, wordEnd(sql, start)).toUpperCase()
}

function lineCommentEnd(sql: string, start: number): number {
  const newline = sql.indexOf('\n', start)
  return newline === -1 ? sql.length : newline + 1
}

/** Skip whitespace and comments; stop at the first real character. */
function skipTrivia(sql: string, start: number): number {
  let index = start
  while (index < sql.length) {
    const ch = sql[index] as string
    if (
      ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
      ch === '\f' || ch === '\v'
    ) {
      index++
      continue
    }
    if (ch === '-' && sql[index + 1] === '-') {
      index = lineCommentEnd(sql, index)
      continue
    }
    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) return sql.length
      index = end + 2
      continue
    }
    break
  }
  return index
}

function quoteLabel(quote: string): string {
  if (quote === "'") return 'string literal'
  if (quote === '"') return 'quoted identifier'
  return 'backtick identifier'
}

/** Index just past a quoted literal/identifier, or -1 when unterminated. */
function quotedEnd(sql: string, start: number, quote: string): number {
  let index = start + 1
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2
        continue
      }
      return index + 1
    }
    index++
  }
  return -1
}

function scanSql(sql: string): ScanResult {
  const operators: OperatorMark[] = []
  const clauses: ClauseMark[] = []
  let operatorLike = false
  let nestedOperatorLike = false
  let malformed: string | null = null
  let sawLimit = false
  let depth = 0
  let index = 0
  const length = sql.length

  const fail = (reason: string): void => {
    if (malformed === null) malformed = reason
  }

  while (index < length) {
    const ch = sql[index] as string

    if (ch === '-' && sql[index + 1] === '-') {
      index = lineCommentEnd(sql, index)
      continue
    }

    if (ch === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) {
        fail('Unterminated block comment.')
        break
      }
      index = end + 2
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const end = quotedEnd(sql, index, ch)
      if (end === -1) {
        fail(`Unterminated ${quoteLabel(ch)}.`)
        break
      }
      index = end
      continue
    }

    if (ch === '[') {
      const end = sql.indexOf(']', index + 1)
      if (end === -1) {
        fail('Unterminated bracket identifier.')
        break
      }
      index = end + 1
      continue
    }

    if (ch === '(') {
      depth++
      index++
      continue
    }

    if (ch === ')') {
      if (depth === 0) fail('Unbalanced closing parenthesis.')
      else depth--
      index++
      continue
    }

    if (isWordStart(ch)) {
      const start = index
      const end = wordEnd(sql, start)
      const word = sql.slice(start, end).toUpperCase()

      if (depth > 0) {
        // Inside parentheses the splitter never splits, but callers still
        // need to know a set operation is nested there.
        if (isSetOperatorKeyword(word)) nestedOperatorLike = true
        index = end
        continue
      }

      if (isSetOperatorKeyword(word)) {
        operatorLike = true
        const afterKeyword = skipTrivia(sql, end)
        const nextWord = wordAt(sql, afterKeyword)

        if (nextWord === 'ALL') {
          const allEnd = wordEnd(sql, afterKeyword)
          if (word === 'UNION') {
            operators.push({ operator: 'UNION ALL', start, end: allEnd })
            index = allEnd
            continue
          }
          fail(`${word} ALL is not supported by SQLite; only ${word} is.`)
          index = allEnd
          continue
        }

        if (nextWord === 'DISTINCT') {
          fail(
            word === 'UNION'
              ? 'UNION DISTINCT is not supported by SQLite; UNION already removes duplicates.'
              : `${word} DISTINCT is not supported by SQLite; only ${word} is.`,
          )
          index = wordEnd(sql, afterKeyword)
          continue
        }

        operators.push({ operator: word, start, end })
        index = end
        continue
      }

      if (word === 'ORDER') {
        const afterKeyword = skipTrivia(sql, end)
        if (wordAt(sql, afterKeyword) === 'BY') {
          clauses.push({ kind: 'ORDER_BY', start })
        }
      } else if (word === 'LIMIT') {
        clauses.push({ kind: 'LIMIT', start })
        sawLimit = true
      } else if (word === 'OFFSET' && sawLimit) {
        // `offset` is a legal SQLite identifier (column, alias or CTE
        // name), so it only starts a clause after a LIMIT.
        clauses.push({ kind: 'OFFSET', start })
      }

      index = end
      continue
    }

    index++
  }

  if (depth !== 0) fail('Unbalanced parentheses in the compound query.')

  return { operators, clauses, operatorLike, nestedOperatorLike, malformed }
}

/**
 * True when the statement contains a set-operator keyword anywhere,
 * including inside parentheses (CTE bodies, subqueries and derived
 * tables) where `splitCompoundQuery` deliberately refuses to split.
 */
export function hasCompoundOperator(sql: string): boolean {
  const scan = scanSql(sql)
  return scan.operatorLike || scan.nestedOperatorLike
}

/**
 * Split a SQL statement at its top-level set operators.
 *
 * Returns `null` for an ordinary SELECT with no set operator. Returns an
 * explicit `{ ok: false, reason }` for unsupported or malformed compound
 * forms so the caller never has to guess.
 */
export function splitCompoundQuery(sql: string): CompoundSplitOutcome | null {
  const scan = scanSql(sql)

  if (scan.operators.length === 0 && !scan.operatorLike) return null
  if (scan.malformed !== null) return { ok: false, reason: scan.malformed }
  if (scan.operators.length === 0) return null

  const lastOperator = scan.operators[scan.operators.length - 1] as OperatorMark

  // Clauses before the final operator would target an individual branch,
  // which SQLite does not allow.
  const tailClauses: ClauseMark[] = []
  for (const clause of scan.clauses) {
    if (clause.start < lastOperator.start) {
      return {
        ok: false,
        reason:
          'ORDER BY, LIMIT and OFFSET must follow the final set operator; ' +
          'they cannot target an individual branch.',
      }
    }
    tailClauses.push(clause)
  }

  const orderClauses = tailClauses.filter((clause) => clause.kind === 'ORDER_BY')
  const limitClauses = tailClauses.filter((clause) => clause.kind === 'LIMIT')
  const offsetClauses = tailClauses.filter((clause) => clause.kind === 'OFFSET')

  if (orderClauses.length > 1) {
    return { ok: false, reason: 'A compound query can have only one ORDER BY clause.' }
  }
  if (limitClauses.length > 1) {
    return { ok: false, reason: 'A compound query can have only one LIMIT clause.' }
  }
  if (offsetClauses.length > 1) {
    return { ok: false, reason: 'A compound query can have only one OFFSET clause.' }
  }

  const orderStart = orderClauses[0]?.start
  const limitStart = limitClauses[0]?.start
  const offsetStart = offsetClauses[0]?.start

  if (orderStart !== undefined && limitStart !== undefined && orderStart > limitStart) {
    return { ok: false, reason: 'ORDER BY must precede LIMIT in a compound query.' }
  }

  const tailStart = Math.min(
    orderStart ?? sql.length,
    limitStart ?? sql.length,
    offsetStart ?? sql.length,
  )

  const segments: CompoundSegment[] = []
  for (let branch = 0; branch < scan.operators.length + 1; branch++) {
    const start =
      branch === 0 ? 0 : (scan.operators[branch - 1] as OperatorMark).end
    const end =
      branch === scan.operators.length
        ? tailStart
        : (scan.operators[branch] as OperatorMark).start
    const text = sql.slice(start, end).trim()

    if (!hasExecutableContent(text)) {
      return {
        ok: false,
        reason: `Branch ${branch + 1} is empty; every set operator needs a query on both sides.`,
      }
    }
    if (text.startsWith('(')) {
      return {
        ok: false,
        reason: 'Parenthesized set-operation branches are not supported by SQLite.',
      }
    }

    segments.push({
      sql: text,
      operator:
        branch === 0 ? null : (scan.operators[branch - 1] as OperatorMark).operator,
    })
  }

  const orderBy =
    orderStart === undefined
      ? null
      : sql.slice(orderStart, limitStart ?? sql.length).trim()
  const limit = limitStart === undefined ? null : sql.slice(limitStart).trim()

  return { ok: true, segments, tail: { orderBy, limit } }
}
