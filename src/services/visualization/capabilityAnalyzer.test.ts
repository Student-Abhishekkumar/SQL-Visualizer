import { describe, expect, it } from 'vitest'
import { interpretStatement } from './astInterpreter'
import { analyzeCapability } from './capabilityAnalyzer'

describe('analyzeCapability — supported queries', () => {
  it('supports a plain SELECT * with only FROM and SELECT stages', () => {
    const capability = analyzeCapability(interpretStatement('SELECT * FROM employees'))
    expect(capability.supported).toBe(true)
    expect(capability.supportedStages).toEqual(['FROM', 'SELECT'])
    expect(capability.unsupportedReason).toBeUndefined()
    expect(capability.isReadOnly).toBe(true)
    expect(capability.hasAggregation).toBe(false)
    expect(capability.hasJoin).toBe(false)
  })

  it('lists WHERE, DISTINCT, ORDER BY and LIMIT stages when used', () => {
    const capability = analyzeCapability(
      interpretStatement('SELECT DISTINCT city FROM employees WHERE age > 25 ORDER BY city LIMIT 5'),
    )
    expect(capability.supportedStages).toEqual([
      'FROM', 'WHERE', 'SELECT', 'DISTINCT', 'ORDER_BY', 'LIMIT',
    ])
  })

  it('inserts JOIN and GROUP_BY/HAVING stages in logical order', () => {
    const capability = analyzeCapability(
      interpretStatement(
        'SELECT d.department_name, COUNT(*) FROM employees e INNER JOIN departments d ON e.department_id = d.id GROUP BY d.department_name HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 3',
      ),
    )
    expect(capability.supportedStages).toEqual([
      'FROM', 'JOIN', 'GROUP_BY', 'HAVING', 'SELECT', 'ORDER_BY', 'LIMIT',
    ])
    expect(capability.hasJoin).toBe(true)
    expect(capability.hasAggregation).toBe(true)
  })

  it('detects the operators and aggregates actually used', () => {
    const capability = analyzeCapability(
      interpretStatement(
        "SELECT name FROM employees WHERE salary BETWEEN 40000 AND 70000 AND city IN ('Delhi') AND name LIKE 'R%'",
      ),
    )
    const details = capability.detected.map((item) => item.detail)
    expect(details).toContain('BETWEEN')
    expect(details).toContain('IN')
    expect(details).toContain('LIKE')
  })

  it('classifies complexity from table sizes', () => {
    const sql = 'SELECT * FROM employees'
    expect(analyzeCapability(interpretStatement(sql), { employees: 8 }).estimatedComplexity).toBe('small')
    expect(analyzeCapability(interpretStatement(sql), { employees: 20_000 }).estimatedComplexity).toBe('medium')
    expect(analyzeCapability(interpretStatement(sql), { employees: 100_000 }).estimatedComplexity).toBe('large')
    expect(analyzeCapability(interpretStatement(sql)).estimatedComplexity).toBe('unknown')
  })

  it('does not hardcode specific tables — works for any user table', () => {
    const capability = analyzeCapability(
      interpretStatement('SELECT * FROM my_custom_table WHERE id < 10'),
    )
    expect(capability.supported).toBe(true)
    expect(capability.detected.some((item) => item.kind === 'source-table' && item.detail === 'my_custom_table')).toBe(true)
  })
})

describe('analyzeCapability — warnings', () => {
  it('warns when aggregates are mixed with bare columns without GROUP BY', () => {
    const capability = analyzeCapability(
      interpretStatement('SELECT name, MAX(salary) FROM employees'),
    )
    expect(capability.supported).toBe(true)
    expect(capability.warnings.some((warning) => warning.kind === 'implicit-aggregation')).toBe(true)
  })

  it('warns for whole-table aggregation without GROUP BY', () => {
    const capability = analyzeCapability(
      interpretStatement('SELECT COUNT(*) FROM employees'),
    )
    expect(capability.supported).toBe(true)
    expect(capability.warnings.some((warning) => warning.kind === 'implicit-aggregation')).toBe(true)
  })
})

describe('analyzeCapability — unsupported queries', () => {
  it('reports non-SELECT statements as unsupported and not read-only', () => {
    const capability = analyzeCapability(interpretStatement('DROP TABLE employees'))
    expect(capability.supported).toBe(false)
    expect(capability.supportedStages).toEqual([])
    expect(capability.unsupportedReason).toMatch(/Only SELECT/i)
  })

  it('reports unsupported SELECT expressions with details', () => {
    const capability = analyzeCapability(
      interpretStatement('SELECT ABS(salary) FROM employees'),
    )
    expect(capability.supported).toBe(false)
    expect(capability.unsupportedFeatures.length).toBeGreaterThan(0)
    expect(capability.unsupportedFeatures[0]?.detail).toMatch(/not visualizable/i)
  })

  it('reports comma cross joins as unsupported', () => {
    const capability = analyzeCapability(
      interpretStatement('SELECT * FROM employees, departments'),
    )
    expect(capability.supported).toBe(false)
    expect(
      capability.unsupportedFeatures.some((feature) =>
        /comma cross joins/i.test(feature.detail ?? ''),
      ),
    ).toBe(true)
  })

  it('supports the numeric LIMIT offset, count syntax through the constant check', () => {
    // `LIMIT 3, 1` means LIMIT 1 OFFSET 3 in SQLite — the interpreter
    // must decode the comma form by SQLite semantics, not by position.
    const structure = interpretStatement('SELECT name FROM employees LIMIT 3, 1').structure
    expect(structure?.limit).toEqual({ limit: 1, offset: 3, text: 'LIMIT 1 OFFSET 3' })
    const capability = analyzeCapability(interpretStatement('SELECT name FROM employees LIMIT 3, 1'))
    expect(capability.supported).toBe(true)
    expect(capability.supportedStages.at(-1)).toBe('LIMIT')
  })
})
