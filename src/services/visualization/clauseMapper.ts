/**
 * Clause mapper — V3 Milestone 5.
 *
 * Maps SQL clauses to source-text spans using a text scan that skips
 * string literals, quoted identifiers and comments. The parser's AST
 * does not carry reliable source positions, so this mapping is purely
 * text-based: each recognized clause keyword starts a span that runs
 * to the next clause keyword (or the end of the statement).
 *
 * The result is used for Monaco clause highlighting and the clickable
 * clause strip in the visualization workspace. When a clause cannot be
 * located (or the text is empty), it is simply absent from the result
 * — callers must handle missing spans gracefully instead of
 * highlighting arbitrary text.
 */

import type { VisualizedStage } from '../../types/visualization'

export interface ClauseSpan {
  /** Pipeline stage this clause belongs to. */
  stage: VisualizedStage
  /** The keyword that starts the clause, as written (uppercased). */
  keyword: string
  /** Character offsets into the original text (end exclusive). */
  start: number
  end: number
  /** 1-based Monaco position of start/end. */
  lineStart: number
  columnStart: number
  lineEnd: number
  columnEnd: number
}

/**
 * Marks, for every character index, whether it is outside string
 * literals, quoted identifiers, bracket identifiers and comments.
 */
function codeMaskOf(sql: string): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(true)
  let i = 0
  const hide = (from: number, to: number): void => {
    for (let k = from; k < to && k < sql.length; k++) mask[k] = false
  }
  while (i < sql.length) {
    const char = sql[i]
    const next = sql[i + 1]
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end + 1
      hide(i, stop)
      i = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      hide(i, stop)
      i = stop
      continue
    }
    if (char === "'") {
      // Single-quoted string: '' escapes a quote.
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          j++
          break
        }
        j++
      }
      hide(i, j)
      i = j
      continue
    }
    if (char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char
      const end = sql.indexOf(closing, i + 1)
      const stop = end === -1 ? sql.length : end + 1
      hide(i, stop)
      i = stop
      continue
    }
    i++
  }
  return mask
}

interface KeywordMatch {
  keyword: string
  stage: VisualizedStage
  start: number
  end: number
}

const KEYWORD_PATTERN =
  /\b(SELECT|DISTINCT|FROM|JOIN|WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET)\b/gi

/**
 * Find clause-keyword occurrences that sit in code (not inside
 * strings/comments/quoted identifiers). Multi-word clauses (GROUP BY,
 * ORDER BY) require their second word; JOIN spans start at a preceding
 * INNER/LEFT/CROSS modifier when one is directly attached.
 */
function findClauseKeywords(sql: string, mask: boolean[]): KeywordMatch[] {
  const matches: KeywordMatch[] = []
  for (const match of sql.matchAll(KEYWORD_PATTERN)) {
    const index = match.index ?? 0
    const text = match[0]
    let fullyCode = true
    for (let k = index; k < index + text.length; k++) {
      if (mask[k] !== true) {
        fullyCode = false
        break
      }
    }
    if (!fullyCode) continue

    const upper = text.toUpperCase()
    if (upper === 'GROUP' || upper === 'ORDER') {
      // Require the following BY (ignoring whitespace/comments between).
      const rest = sql.slice(index + text.length)
      const byMatch = /^\s+BY\b/i.exec(rest)
      if (byMatch === null) continue
      matches.push({
        keyword: `${upper} BY`,
        stage: upper === 'GROUP' ? 'GROUP_BY' : 'ORDER_BY',
        start: index,
        end: index + text.length + byMatch[0].length,
      })
      continue
    }

    const stage: VisualizedStage =
      upper === 'SELECT'
        ? 'SELECT'
        : upper === 'DISTINCT'
          ? 'DISTINCT'
          : upper === 'FROM'
            ? 'FROM'
            : upper === 'JOIN'
              ? 'JOIN'
              : upper === 'WHERE'
                ? 'WHERE'
                : upper === 'HAVING'
                  ? 'HAVING'
                  : 'LIMIT' // LIMIT and OFFSET share the LIMIT stage

    // JOIN: extend the span start backwards across any directly
    // attached modifiers (LEFT OUTER JOIN starts at LEFT).
    let start = index
    if (upper === 'JOIN') {
      for (;;) {
        const modifierMatch = /(\b(?:INNER|LEFT|RIGHT|CROSS|FULL|OUTER|NATURAL)\s*)$/i.exec(
          sql.slice(0, start),
        )
        if (modifierMatch === null) break
        start -= modifierMatch[0].length
      }
    }

    matches.push({ keyword: upper, stage, start, end: index + text.length })
  }
  return matches.sort((a, b) => a.start - b.start)
}

/** Convert a character offset to a 1-based Monaco line/column pair. */
function positionAt(sql: string, offset: number): { line: number; column: number } {
  let line = 1
  let column = 1
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === '\n') {
      line++
      column = 1
    } else {
      column++
    }
  }
  return { line, column }
}

/**
 * Map the query text to clause spans. Deterministic and total: never
 * throws; unrecognized or missing clauses are simply absent.
 */
export function mapQueryClauses(sql: string): ClauseSpan[] {
  if (sql.trim() === '') return []
  const mask = codeMaskOf(sql)
  const keywords = findClauseKeywords(sql, mask)
  const spans: ClauseSpan[] = []
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]
    if (keyword === undefined) continue
    const next = keywords[i + 1]
    const end = next !== undefined ? next.start : sql.length
    const startPos = positionAt(sql, keyword.start)
    const endPos = positionAt(sql, end)
    spans.push({
      stage: keyword.stage,
      keyword: keyword.keyword,
      start: keyword.start,
      end,
      lineStart: startPos.line,
      columnStart: startPos.column,
      lineEnd: endPos.line,
      columnEnd: endPos.column,
    })
  }
  return spans
}

/** The span of a given stage, when present. */
export function spanOfStage(spans: ClauseSpan[], stage: VisualizedStage): ClauseSpan | null {
  return spans.find((span) => span.stage === stage) ?? null
}
