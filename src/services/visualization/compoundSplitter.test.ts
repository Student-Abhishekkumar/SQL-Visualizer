import { describe, expect, it } from 'vitest'
import {
  splitCompoundQuery,
  type CompoundOperator,
  type CompoundSplitOutcome,
} from './compoundSplitter'

type Success = Extract<CompoundSplitOutcome, { ok: true }>

function splitOrThrow(sql: string): Success {
  const result = splitCompoundQuery(sql)
  if (result === null) throw new Error('Expected a compound query, got null')
  if (!result.ok) throw new Error(`Expected a split, got rejection: ${result.reason}`)
  return result
}

function rejectionReason(sql: string): string {
  const result = splitCompoundQuery(sql)
  if (result === null) throw new Error('Expected a compound query, got null')
  if (result.ok) throw new Error('Expected a rejection, got a split')
  return result.reason
}

describe('operator recognition', () => {
  const cases: Array<{
    name: string
    sql: string
    operators: Array<CompoundOperator | null>
  }> = [
    {
      name: 'UNION',
      sql: 'SELECT id FROM a UNION SELECT id FROM b',
      operators: [null, 'UNION'],
    },
    {
      name: 'UNION ALL',
      sql: 'SELECT id FROM a UNION ALL SELECT id FROM b',
      operators: [null, 'UNION ALL'],
    },
    {
      name: 'INTERSECT',
      sql: 'SELECT id FROM a INTERSECT SELECT id FROM b',
      operators: [null, 'INTERSECT'],
    },
    {
      name: 'EXCEPT',
      sql: 'SELECT id FROM a EXCEPT SELECT id FROM b',
      operators: [null, 'EXCEPT'],
    },
    {
      name: 'four-branch mixed chain',
      sql: 'SELECT 1 AS v UNION SELECT 2 INTERSECT SELECT 3 EXCEPT SELECT 4',
      operators: [null, 'UNION', 'INTERSECT', 'EXCEPT'],
    },
    {
      name: 'mixed casing',
      sql: 'SeLeCt 1 UnIoN SeLeCt 2 InTeRsEcT SeLeCt 3 ExCePt SeLeCt 4',
      operators: [null, 'UNION', 'INTERSECT', 'EXCEPT'],
    },
    {
      name: 'repeated INTERSECT',
      sql: 'SELECT 1 INTERSECT SELECT 2 INTERSECT SELECT 3',
      operators: [null, 'INTERSECT', 'INTERSECT'],
    },
    {
      name: 'UNION ALL with a comment before ALL',
      sql: 'SELECT 1 UNION /* note */ ALL SELECT 2',
      operators: [null, 'UNION ALL'],
    },
  ]

  it.each(cases)('$name', ({ sql, operators }) => {
    const result = splitOrThrow(sql)
    expect(result.segments.map((segment) => segment.operator)).toEqual(operators)
    expect(result.segments).toHaveLength(operators.length)
    expect(result.tail).toEqual({ orderBy: null, limit: null })
  })

  it('preserves the original branch text', () => {
    const result = splitOrThrow(
      'SELECT 1 AS v UNION ALL SELECT 2 INTERSECT SELECT 3 EXCEPT SELECT 4',
    )
    expect(result.segments.map((segment) => segment.sql)).toEqual([
      'SELECT 1 AS v',
      'SELECT 2',
      'SELECT 3',
      'SELECT 4',
    ])
  })
})

describe('quoting styles', () => {
  const cases: Array<{
    name: string
    sql: string
    operator: CompoundOperator
  }> = [
    {
      name: 'single-quoted strings',
      sql: "SELECT 'UNION SELECT' AS x FROM a INTERSECT SELECT 'EXCEPT' FROM b",
      operator: 'INTERSECT',
    },
    {
      name: 'double-quoted identifiers',
      sql: 'SELECT "UNION" FROM a INTERSECT SELECT "EXCEPT" FROM b',
      operator: 'INTERSECT',
    },
    {
      name: 'backtick identifiers',
      sql: 'SELECT `EXCEPT` FROM a UNION SELECT `INTERSECT` FROM b',
      operator: 'UNION',
    },
    {
      name: 'bracket identifiers',
      sql: 'SELECT [UNION ALL] FROM a EXCEPT SELECT [EXCEPT] FROM b',
      operator: 'EXCEPT',
    },
    {
      name: 'escaped single quotes',
      sql: "SELECT 'it''s UNION' FROM a INTERSECT SELECT 'it''s EXCEPT' FROM b",
      operator: 'INTERSECT',
    },
    {
      name: 'escaped double quotes',
      sql: 'SELECT "a""UNION" FROM a UNION ALL SELECT "b""EXCEPT" FROM b',
      operator: 'UNION ALL',
    },
    {
      name: 'escaped backticks',
      sql: 'SELECT `a``EXCEPT` FROM a UNION SELECT `b``INTERSECT` FROM b',
      operator: 'UNION',
    },
  ]

  it.each(cases)('ignores operators inside $name', ({ sql, operator }) => {
    const result = splitOrThrow(sql)
    expect(result.segments).toHaveLength(2)
    expect(result.segments.map((segment) => segment.operator)).toEqual([null, operator])
  })
})

describe('comments', () => {
  it('ignores a block comment containing operators', () => {
    const result = splitOrThrow(
      'SELECT 1 /* UNION SELECT 2 INTERSECT SELECT 3 EXCEPT SELECT 4 */ UNION SELECT 5',
    )
    expect(result.segments.map((segment) => segment.operator)).toEqual([null, 'UNION'])
  })

  it('ignores a line comment containing operators', () => {
    const result = splitOrThrow(
      'SELECT 1 -- UNION SELECT 2\nINTERSECT SELECT 3',
    )
    expect(result.segments.map((segment) => segment.operator)).toEqual([null, 'INTERSECT'])
  })

  it('keeps comments attached to the branch text', () => {
    const result = splitOrThrow(
      'SELECT 1 -- first branch\nINTERSECT SELECT 2',
    )
    expect(result.segments[0]?.sql).toBe('SELECT 1 -- first branch')
  })
})

describe('parenthesized expressions and nested queries', () => {
  it('ignores operators inside parenthesized expressions', () => {
    const result = splitOrThrow(
      'SELECT (1 + (2 * 3)) AS x FROM a UNION SELECT (4) FROM b',
    )
    expect(result.segments).toHaveLength(2)
    expect(result.segments[1]?.operator).toBe('UNION')
  })

  it('returns null when the only compound query is a nested subquery', () => {
    expect(splitCompoundQuery('SELECT * FROM (SELECT 1 UNION SELECT 2) AS t')).toBeNull()
  })

  it('does not split a nested subquery when an outer operator exists', () => {
    const result = splitOrThrow(
      'SELECT * FROM (SELECT 1 UNION SELECT 2) AS t INTERSECT SELECT * FROM u',
    )
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.sql).toBe('SELECT * FROM (SELECT 1 UNION SELECT 2) AS t')
    expect(result.segments[1]?.operator).toBe('INTERSECT')
  })

  it('does not split a CTE body', () => {
    const result = splitOrThrow(
      'WITH x AS (SELECT 1 UNION SELECT 2) SELECT * FROM x INTERSECT SELECT * FROM y',
    )
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.sql).toBe(
      'WITH x AS (SELECT 1 UNION SELECT 2) SELECT * FROM x',
    )
    expect(result.segments[1]?.operator).toBe('INTERSECT')
  })

  it('does not split a subquery that uses a different operator', () => {
    const result = splitOrThrow(
      'SELECT 1 WHERE 1 IN (SELECT 2 UNION ALL SELECT 3) EXCEPT SELECT 4',
    )
    expect(result.segments).toHaveLength(2)
    expect(result.segments[1]?.operator).toBe('EXCEPT')
  })

  it('handles a CTE body with its own compound operator', () => {
    const result = splitOrThrow(
      'WITH x AS (SELECT 1 EXCEPT SELECT 2) SELECT * FROM x UNION SELECT 3',
    )
    expect(result.segments).toHaveLength(2)
    expect(result.segments[1]?.operator).toBe('UNION')
  })
})

describe('root-level ORDER BY and LIMIT', () => {
  it('extracts a root ORDER BY from the final branch', () => {
    const result = splitOrThrow('SELECT 1 AS v UNION SELECT 2 ORDER BY v DESC')
    expect(result.segments.map((segment) => segment.sql)).toEqual([
      'SELECT 1 AS v',
      'SELECT 2',
    ])
    expect(result.tail).toEqual({ orderBy: 'ORDER BY v DESC', limit: null })
  })

  it('recognizes ORDER BY split across a newline', () => {
    const result = splitOrThrow('SELECT 1 UNION SELECT 2 ORDER\nBY 1')
    expect(result.tail.orderBy).toBe('ORDER\nBY 1')
  })

  it('extracts a root LIMIT', () => {
    const result = splitOrThrow('SELECT 1 UNION SELECT 2 LIMIT 5')
    expect(result.segments[1]?.sql).toBe('SELECT 2')
    expect(result.tail).toEqual({ orderBy: null, limit: 'LIMIT 5' })
  })

  it('extracts ORDER BY and LIMIT/OFFSET together', () => {
    const result = splitOrThrow(
      'SELECT 1 UNION SELECT 2 ORDER BY 1 DESC LIMIT 5 OFFSET 2',
    )
    expect(result.segments[1]?.sql).toBe('SELECT 2')
    expect(result.tail).toEqual({
      orderBy: 'ORDER BY 1 DESC',
      limit: 'LIMIT 5 OFFSET 2',
    })
  })

  it('keeps LIMIT with an OFFSET of 0 in the tail', () => {
    const result = splitOrThrow('SELECT 1 UNION SELECT 2 LIMIT 1 OFFSET 0')
    expect(result.segments[1]?.sql).toBe('SELECT 2')
    expect(result.tail).toEqual({ orderBy: null, limit: 'LIMIT 1 OFFSET 0' })
  })

  it('does not treat a nested ORDER BY/LIMIT as the compound tail', () => {
    const result = splitOrThrow(
      'SELECT 1 UNION SELECT * FROM (SELECT 2 ORDER BY 1 LIMIT 1) AS t',
    )
    expect(result.segments[1]?.sql).toBe(
      'SELECT * FROM (SELECT 2 ORDER BY 1 LIMIT 1) AS t',
    )
    expect(result.tail).toEqual({ orderBy: null, limit: null })
  })
})

describe('offset used as an identifier', () => {
  it('does not treat an offset alias as a clause', () => {
    const result = splitOrThrow('SELECT 1 AS offset UNION SELECT 2')
    expect(result.segments.map((segment) => segment.sql)).toEqual([
      'SELECT 1 AS offset',
      'SELECT 2',
    ])
    expect(result.tail).toEqual({ orderBy: null, limit: null })
  })

  it('does not treat an offset column as a clause', () => {
    const result = splitOrThrow('SELECT offset FROM t UNION SELECT 2')
    expect(result.segments[0]?.sql).toBe('SELECT offset FROM t')
    expect(result.tail).toEqual({ orderBy: null, limit: null })
  })

  it('does not treat an offset CTE name as a clause', () => {
    const result = splitOrThrow(
      'WITH offset AS (SELECT 1) SELECT * FROM offset UNION SELECT 2',
    )
    expect(result.segments[0]?.sql).toBe(
      'WITH offset AS (SELECT 1) SELECT * FROM offset',
    )
    expect(result.tail).toEqual({ orderBy: null, limit: null })
  })

  it('still recognizes OFFSET after a top-level LIMIT', () => {
    const result = splitOrThrow('SELECT offset FROM t UNION SELECT 2 LIMIT 1 OFFSET 0')
    expect(result.segments[1]?.sql).toBe('SELECT 2')
    expect(result.tail).toEqual({ orderBy: null, limit: 'LIMIT 1 OFFSET 0' })
  })
})

describe('unsupported compound forms', () => {
  it('rejects INTERSECT ALL', () => {
    expect(rejectionReason('SELECT 1 INTERSECT ALL SELECT 2')).toContain(
      'INTERSECT ALL is not supported by SQLite',
    )
  })

  it('rejects EXCEPT ALL', () => {
    expect(rejectionReason('SELECT 1 EXCEPT ALL SELECT 2')).toContain(
      'EXCEPT ALL is not supported by SQLite',
    )
  })

  it('rejects UNION DISTINCT', () => {
    expect(rejectionReason('SELECT 1 UNION DISTINCT SELECT 2')).toContain(
      'UNION DISTINCT is not supported by SQLite',
    )
  })

  it('rejects INTERSECT DISTINCT', () => {
    expect(rejectionReason('SELECT 1 INTERSECT DISTINCT SELECT 2')).toContain(
      'INTERSECT DISTINCT is not supported by SQLite',
    )
  })

  it('rejects parenthesized set-operation branches', () => {
    expect(
      rejectionReason('(SELECT 1 UNION SELECT 2) INTERSECT SELECT 3'),
    ).toContain('Parenthesized set-operation branches')
  })
})

describe('non-terminal ORDER BY / LIMIT / OFFSET', () => {
  const cases: Array<{ sql: string; label: string }> = [
    { sql: 'SELECT 1 ORDER BY 1 UNION SELECT 2', label: 'ORDER BY on the first branch' },
    { sql: 'SELECT 1 LIMIT 1 UNION SELECT 2', label: 'LIMIT on the first branch' },
    { sql: 'SELECT 1 LIMIT 1 OFFSET 1 UNION SELECT 2', label: 'LIMIT/OFFSET on the first branch' },
    {
      sql: 'SELECT 1 UNION SELECT 2 ORDER BY 1 UNION SELECT 3',
      label: 'ORDER BY in the middle of the chain',
    },
    {
      sql: 'SELECT 1 UNION SELECT 2 LIMIT 1 INTERSECT SELECT 3',
      label: 'LIMIT in the middle of the chain',
    },
  ]

  it.each(cases)('rejects $label', ({ sql }) => {
    expect(rejectionReason(sql)).toContain('must follow the final set operator')
  })
})

describe('ordinary SELECT statements', () => {
  const cases = [
    'SELECT * FROM t',
    'SELECT * FROM t ORDER BY 1 LIMIT 2 OFFSET 3',
    'WITH x AS (SELECT 1 UNION SELECT 2) SELECT * FROM x',
    "SELECT 'UNION SELECT 2'",
    'SELECT "UNION" FROM t',
    'SELECT 1 -- UNION SELECT 2',
  ]

  it.each(cases)('returns null for %s', (sql) => {
    expect(splitCompoundQuery(sql)).toBeNull()
  })
})

describe('malformed compound queries', () => {
  const cases: Array<{ sql: string; reason: RegExp }> = [
    { sql: 'SELECT 1 UNION', reason: /Branch 2 is empty/ },
    { sql: 'UNION SELECT 1', reason: /Branch 1 is empty/ },
    { sql: 'SELECT 1 UNION UNION SELECT 2', reason: /Branch 2 is empty/ },
    { sql: 'SELECT 1 UNION /* nothing */', reason: /Branch 2 is empty/ },
    { sql: 'SELECT 1 UNION SELECT 2 /* oops', reason: /Unterminated block comment/ },
    { sql: "SELECT 1 UNION SELECT 'oops", reason: /Unterminated string literal/ },
    { sql: 'SELECT 1 UNION SELECT [oops', reason: /Unterminated bracket identifier/ },
    {
      sql: 'SELECT (1) ) UNION SELECT 2',
      reason: /Unbalanced closing parenthesis/,
    },
    { sql: 'SELECT 1 UNION SELECT (2', reason: /Unbalanced parentheses/ },
    {
      sql: 'SELECT 1 UNION SELECT 2 ORDER BY 1 ORDER BY 2',
      reason: /only one ORDER BY/,
    },
    {
      sql: 'SELECT 1 UNION SELECT 2 LIMIT 1 LIMIT 2',
      reason: /only one LIMIT/,
    },
    {
      sql: 'SELECT 1 UNION SELECT 2 LIMIT 1 OFFSET 2 OFFSET 3',
      reason: /only one OFFSET/,
    },
    {
      sql: 'SELECT 1 UNION SELECT 2 LIMIT 1 ORDER BY 1',
      reason: /ORDER BY must precede LIMIT/,
    },
  ]

  it.each(cases)('rejects $sql', ({ sql, reason }) => {
    expect(rejectionReason(sql)).toMatch(reason)
  })
})
