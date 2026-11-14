import { describe, expect, it } from 'vitest'
import { mapQueryClauses, spanOfStage } from './clauseMapper'

/**
 * Text-based clause mapping: spans must be real offsets into the
 * query, skip strings/comments/quoted identifiers, and be absent (not
 * invented) when a clause does not exist.
 */

describe('mapQueryClauses — basic clauses', () => {
  it('maps SELECT / FROM / WHERE to real spans', () => {
    const sql = 'SELECT name, salary FROM employees WHERE salary > 50000'
    const spans = mapQueryClauses(sql)
    expect(spans.map((span) => span.stage)).toEqual(['SELECT', 'FROM', 'WHERE'])

    const select = spanOfStage(spans, 'SELECT')
    expect(select?.start).toBe(0)
    expect(select?.keyword).toBe('SELECT')
    // SELECT span ends where FROM starts.
    const from = spanOfStage(spans, 'FROM')
    expect(select?.end).toBe(from?.start)
    expect(sql.slice(select!.start, select!.end)).toBe('SELECT name, salary ')
    expect(sql.slice(from!.start, from!.end)).toBe('FROM employees ')
  })

  it('maps GROUP BY / HAVING / ORDER BY / LIMIT / OFFSET', () => {
    const sql = `SELECT department_id, COUNT(*) AS total
FROM employees
GROUP BY department_id
HAVING COUNT(*) > 1
ORDER BY total DESC
LIMIT 3 OFFSET 1`
    const spans = mapQueryClauses(sql)
    expect(spans.map((span) => span.stage)).toEqual([
      'SELECT',
      'FROM',
      'GROUP_BY',
      'HAVING',
      'ORDER_BY',
      'LIMIT',
      'LIMIT', // OFFSET shares the LIMIT stage
    ])
    expect(spans.find((span) => span.stage === 'GROUP_BY')?.keyword).toBe('GROUP BY')
    expect(spans.find((span) => span.stage === 'ORDER_BY')?.keyword).toBe('ORDER BY')
    const limit = spans.filter((span) => span.stage === 'LIMIT')
    expect(sql.slice(limit[0]!.start, limit[0]!.end)).toBe('LIMIT 3 ')
    expect(sql.slice(limit[1]!.start, limit[1]!.end)).toBe('OFFSET 1')
  })

  it('provides 1-based Monaco line/column positions', () => {
    const sql = 'SELECT name\nFROM employees\nWHERE age > 25'
    const spans = mapQueryClauses(sql)
    const where = spanOfStage(spans, 'WHERE')
    expect(where?.lineStart).toBe(3)
    expect(where?.columnStart).toBe(1)
  })

  it('maps DISTINCT as its own clause span', () => {
    const sql = 'SELECT DISTINCT city FROM employees'
    const spans = mapQueryClauses(sql)
    expect(spans.map((span) => span.stage)).toEqual(['SELECT', 'DISTINCT', 'FROM'])
    expect(sql.slice(spans[1]!.start, spans[1]!.end)).toBe('DISTINCT city ')
  })
})

describe('mapQueryClauses — JOIN', () => {
  it('starts the span at the INNER modifier', () => {
    const sql =
      'SELECT employees.name FROM employees INNER JOIN departments ON employees.department_id = departments.id'
    const spans = mapQueryClauses(sql)
    const join = spanOfStage(spans, 'JOIN')
    expect(join?.keyword).toBe('JOIN')
    // The span covers the whole JOIN clause (including its ON condition)
    // and starts at the modifier.
    expect(sql.slice(join!.start, join!.end)).toBe(
      'INNER JOIN departments ON employees.department_id = departments.id',
    )
  })

  it('starts a LEFT OUTER JOIN span at LEFT', () => {
    const sql = 'SELECT * FROM a LEFT OUTER JOIN b ON a.id = b.id'
    const join = spanOfStage(mapQueryClauses(sql), 'JOIN')
    expect(sql.slice(join!.start, join!.start + 'LEFT OUTER JOIN'.length)).toBe('LEFT OUTER JOIN')
    expect(sql.slice(join!.start, join!.end)).toBe('LEFT OUTER JOIN b ON a.id = b.id')
  })

  it('bare JOIN starts at the JOIN keyword', () => {
    const sql = 'SELECT * FROM a JOIN b ON a.id = b.id'
    const join = spanOfStage(mapQueryClauses(sql), 'JOIN')
    expect(sql.slice(join!.start, join!.start + 4)).toBe('JOIN')
  })
})

describe('mapQueryClauses — ignores non-code occurrences', () => {
  it('does not treat keywords inside string literals as clauses', () => {
    const sql = "SELECT 'where and from' FROM t"
    const spans = mapQueryClauses(sql)
    expect(spans.map((span) => span.stage)).toEqual(['SELECT', 'FROM'])
    expect(spanOfStage(spans, 'WHERE')).toBeNull()
  })

  it('does not treat keywords inside comments as clauses', () => {
    const sql = '-- join nothing yet\nSELECT * FROM t -- group by later'
    const spans = mapQueryClauses(sql)
    expect(spans.map((span) => span.stage)).toEqual(['SELECT', 'FROM'])
  })

  it('does not treat keywords inside block comments or quoted identifiers as clauses', () => {
    const sql = '/* WHERE */ SELECT "where" AS [from] FROM t'
    const spans = mapQueryClauses(sql)
    expect(spans.map((span) => span.stage)).toEqual(['SELECT', 'FROM'])
  })

  it('does not match keywords that are part of longer identifiers', () => {
    const sql = 'SELECT limit_count, group_size FROM ordering_table'
    expect(mapQueryClauses(sql).map((span) => span.stage)).toEqual(['SELECT', 'FROM'])
  })
})

describe('mapQueryClauses — graceful behavior', () => {
  it('returns no spans for empty or clause-less text', () => {
    expect(mapQueryClauses('')).toEqual([])
    expect(mapQueryClauses('   \n  ')).toEqual([])
    expect(mapQueryClauses('banana')).toEqual([])
  })

  it('returns an empty list rather than throwing on broken SQL', () => {
    const spans = mapQueryClauses("SELECT 'unterminated")
    // The unterminated string swallows the rest — SELECT may or may not
    // be found, but nothing throws and nothing is invented.
    expect(spans.every((span) => span.start < span.end)).toBe(true)
  })

  it('is deterministic', () => {
    const sql = 'SELECT name FROM employees WHERE salary > 1 ORDER BY name LIMIT 2'
    expect(mapQueryClauses(sql)).toEqual(mapQueryClauses(sql))
  })
})
