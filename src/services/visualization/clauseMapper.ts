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

import type {
  NestedQueryTrace,
  QueryBlockId,
  VisualizedStage,
} from '../../types/visualization'
import { ROOT_BLOCK_ID, stageKeyFor } from './queryBlocks'

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
  /**
   * Query block that owns this occurrence. Nested blocks have their own
   * SELECT/FROM/WHERE, so the stage name alone is ambiguous.
   */
  blockId: QueryBlockId
  /**
   * Block-scoped stage key (`q2:WHERE`; bare `WHERE` for the root). This
   * is what highlighting and playback activation compare.
   */
  stageKey: string
}

export interface ClauseMappingOptions {
  /** Nested blocks of the statement, used to attribute occurrences. */
  nestedQueries?: NestedQueryTrace[]
  /** Root block id (defaults to q1). */
  rootBlockId?: QueryBlockId
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

interface ParenRegion {
  open: number
  close: number
  contentStart: number
  contentEnd: number
}

/** True when the first code token inside a parenthesized range is SELECT. */
function startsWithSelect(sql: string, mask: boolean[], from: number, to: number): boolean {
  let i = from
  while (i < to) {
    const char = sql[i] ?? ''
    if (mask[i] !== true || /\s/.test(char)) {
      i++
      continue
    }
    if (!/[A-Za-z]/.test(char)) return false
    if (sql.slice(i, i + 'SELECT'.length).toUpperCase() !== 'SELECT') return false
    const after = sql[i + 'SELECT'.length]
    if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) return false
    return true
  }
  return false
}

/**
 * Parenthesized regions whose first code token is SELECT, i.e. nested
 * query blocks in source order. The AST carries no positions, so these
 * regions are the only reliable way to attribute a clause keyword to a
 * block. Strings/comments/quoted identifiers never count.
 */
function findSubqueryRegions(sql: string, mask: boolean[]): ParenRegion[] {
  const stack: number[] = []
  const regions: ParenRegion[] = []
  for (let i = 0; i < sql.length; i++) {
    if (mask[i] !== true) continue
    const char = sql[i]
    if (char === '(') {
      stack.push(i)
      continue
    }
    if (char !== ')') continue
    const open = stack.pop()
    if (open === undefined) continue
    if (startsWithSelect(sql, mask, open + 1, i)) {
      regions.push({ open, close: i, contentStart: open + 1, contentEnd: i })
    }
  }
  return regions.sort((a, b) => a.open - b.open)
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Attribute source regions to nested blocks. An exact normalized-text
 * match against the block's rendered SQL wins; any remaining block is
 * assigned to the next unclaimed region in source order so multiple
 * occurrences still get distinct, deterministic identities.
 */
function regionsForBlocks(
  regions: ParenRegion[],
  sql: string,
  blocks: NestedQueryTrace[],
): Map<number, QueryBlockId> {
  const owner = new Map<number, QueryBlockId>()
  const claimed = new Set<number>()
  for (const block of blocks) {
    const wanted = normalizeSql(block.sql)
    const match = regions.findIndex(
      (region, index) =>
        !claimed.has(index) && normalizeSql(sql.slice(region.contentStart, region.contentEnd)) === wanted,
    )
    if (match >= 0) {
      owner.set(match, block.id)
      claimed.add(match)
    }
  }
  let cursor = 0
  for (const block of blocks) {
    if ([...owner.values()].includes(block.id)) continue
    while (cursor < regions.length && claimed.has(cursor)) cursor++
    if (cursor >= regions.length) break
    owner.set(cursor, block.id)
    claimed.add(cursor)
    cursor++
  }
  return owner
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
export function mapQueryClauses(
  sql: string,
  options: ClauseMappingOptions = {},
): ClauseSpan[] {
  if (sql.trim() === '') return []
  const rootId = options.rootBlockId ?? ROOT_BLOCK_ID
  const blocks = options.nestedQueries ?? []
  const mask = codeMaskOf(sql)
  const keywords = findClauseKeywords(sql, mask)
  const regions = findSubqueryRegions(sql, mask)
  const regionOwner = regionsForBlocks(regions, sql, blocks)

  const innermostRegion = (offset: number): number => {
    let best = -1
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index]
      if (region === undefined) continue
      if (offset <= region.open || offset >= region.close) continue
      if (
        best === -1 ||
        region.close - region.open <
          (regions[best] as ParenRegion).close - (regions[best] as ParenRegion).open
      ) {
        best = index
      }
    }
    return best
  }

  // `undefined` means "inside an unlabeled nested region" — such keywords
  // belong to no simulated block and are skipped rather than blamed on
  // the outer query.
  const ownerOf = (offset: number): QueryBlockId | undefined => {
    const region = innermostRegion(offset)
    if (region === -1) return rootId
    return regionOwner.get(region)
  }

  const boundaryOf = (blockId: QueryBlockId): number => {
    if (blockId === rootId) return sql.length
    for (const [index, owner] of regionOwner) {
      if (owner === blockId) return regions[index]?.close ?? sql.length
    }
    return sql.length
  }

  const spans: ClauseSpan[] = []
  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]
    if (keyword === undefined) continue
    const owner = ownerOf(keyword.start)
    if (owner === undefined) continue
    // The clause ends at the next keyword owned by the same block (or at
    // the block's own closing parenthesis), never at another block's
    // keyword. An outer WHERE therefore still covers its subquery text.
    let end = boundaryOf(owner)
    for (let j = i + 1; j < keywords.length; j++) {
      const candidate = keywords[j]
      if (candidate === undefined) continue
      if (ownerOf(candidate.start) === owner) {
        end = candidate.start
        break
      }
    }
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
      blockId: owner,
      stageKey: stageKeyFor(owner, keyword.stage, rootId),
    })
  }
  return spans.sort((a, b) => a.start - b.start)
}

/**
 * The span of a stage. Without a block id the root block is preferred,
 * so existing single-query callers keep their behavior and a root WHERE
 * never resolves to an inner WHERE. Pass `blockId` for an exact match.
 */
export function spanOfStage(
  spans: ClauseSpan[],
  stage: VisualizedStage,
  blockId?: QueryBlockId | null,
): ClauseSpan | null {
  if (blockId !== undefined && blockId !== null) {
    return spans.find((span) => span.stage === stage && span.blockId === blockId) ?? null
  }
  return (
    spans.find((span) => span.stage === stage && span.stageKey === span.stage) ??
    spans.find((span) => span.stage === stage) ??
    null
  )
}
