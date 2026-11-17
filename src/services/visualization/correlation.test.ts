import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { detectCorrelation } from './correlation'
import { simulateQuery, type TableData } from './simulator'

/**
 * Correlation detection must catch both qualified and unqualified outer
 * references, while respecting SQL's innermost-scope rule.
 */

const TABLES: Record<string, TableData> = {
  employees: {
    columns: ['id', 'name', 'salary', 'age'],
    rows: [[1, 'Ravi', 62000, 30]],
  },
  departments: {
    columns: ['id', 'department_name', 'budget'],
    rows: [[1, 'Engineering', 100000]],
  },
  teams: {
    columns: ['id', 'salary'],
    rows: [[1, 50000]],
  },
}
const getTableData = (name: string): TableData | null => TABLES[name] ?? null

function structureOf(sql: string) {
  const interpretation = interpretQuery(sql, [sql])
  if (interpretation.structure === null) throw new Error(interpretation.unsupportedReasons.join('; '))
  return interpretation.structure
}

function detect(outerSql: string, innerSql: string) {
  return detectCorrelation(structureOf(innerSql), [structureOf(outerSql)], getTableData)
}

const OUTER = 'SELECT name FROM employees WHERE age > 20'

describe('detectCorrelation', () => {
  it('detects a qualified outer reference', () => {
    const finding = detect(
      'SELECT name FROM employees e WHERE age > 20',
      'SELECT AVG(budget) FROM departments d WHERE d.budget > e.salary',
    )
    expect(finding.correlated).toBe(true)
    expect(finding.reference).toBe('e.salary')
  })

  it('detects an unqualified outer reference', () => {
    // `salary` exists only in the outer employees table.
    const finding = detect(
      OUTER,
      'SELECT AVG(budget) FROM departments WHERE budget > salary',
    )
    expect(finding.correlated).toBe(true)
    expect(finding.reference).toBe('salary')
    expect(finding.schemaResolved).toBe(true)
  })

  it('does not mark a self-contained inner query as correlated', () => {
    const finding = detect(OUTER, 'SELECT AVG(budget) FROM departments WHERE budget > 50000')
    expect(finding.correlated).toBe(false)
  })

  it('treats a column present in both scopes as local (inner scope wins)', () => {
    // Both employees and teams have `salary`; SQL resolves it to teams.
    const finding = detect(OUTER, 'SELECT AVG(salary) FROM teams')
    expect(finding.correlated).toBe(false)
  })

  it('fails conservatively when a qualified reference leaves the inner scope', () => {
    const finding = detect(
      OUTER,
      'SELECT AVG(budget) FROM departments WHERE budget > missing_alias.salary',
    )
    expect(finding.correlated).toBe(true)
  })

  it('does not mark an unknown unqualified column as correlated', () => {
    // The simulator’s normal unknown-column error is the honest result.
    const finding = detect(OUTER, 'SELECT AVG(budget) FROM departments WHERE budget > nope')
    expect(finding.correlated).toBe(false)
  })

  it('never advertises an unqualified correlated query as supported', () => {
    const sql =
      'SELECT name FROM employees WHERE salary > (SELECT AVG(budget) FROM departments WHERE budget > salary)'
    const interpretation = interpretQuery(sql, [sql])
    expect(interpretation.structure).not.toBeNull()
    if (interpretation.structure === null) return
    const outcome = simulateQuery(sql, interpretation.structure, getTableData)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reasons.some((reason) => /correlated/i.test(reason))).toBe(true)
    }
  })
})
