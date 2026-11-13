import { describe, expect, it } from 'vitest'
import { interpretQuery, interpretStatement } from './astInterpreter'

/**
 * AST interpretation tests — run against the real node-sql-parser AST
 * for the SQLite dialect (no mocked parser output).
 */

describe('interpretStatement — SELECT basics', () => {
  it('interprets SELECT * with table and no clauses', () => {
    const result = interpretStatement('SELECT * FROM employees')
    expect(result.unsupportedReasons).toEqual([])
    const structure = result.structure
    expect(structure).not.toBeNull()
    expect(structure?.selectAll).toBe(true)
    expect(structure?.from.name).toBe('employees')
    expect(structure?.from.alias).toBeNull()
    expect(structure?.where).toBeNull()
    expect(structure?.groupBy).toEqual([])
    expect(structure?.having).toBeNull()
    expect(structure?.orderBy).toEqual([])
    expect(structure?.limit).toBeNull()
    expect(structure?.distinct).toBe(false)
  })

  it('extracts table aliases', () => {
    const structure = interpretStatement('SELECT e.name FROM employees e').structure
    expect(structure?.from.name).toBe('employees')
    expect(structure?.from.alias).toBe('e')
  })

  it('extracts columns with aliases', () => {
    const structure = interpretStatement(
      'SELECT name AS n, salary * 2 AS doubled FROM employees',
    ).structure
    expect(structure?.selectAll).toBe(false)
    expect(structure?.selectItems).toHaveLength(2)
    expect(structure?.selectItems[0]?.alias).toBe('n')
    expect(structure?.selectItems[0]?.expression).toMatchObject({
      kind: 'column', name: 'name', table: null,
    })
    expect(structure?.selectItems[1]?.alias).toBe('doubled')
    expect(structure?.selectItems[1]?.expression).toMatchObject({
      kind: 'arithmetic', operator: '*',
    })
  })

  it('interprets qualified column references', () => {
    const structure = interpretStatement(
      "SELECT e.name, d.department_name FROM employees e INNER JOIN departments d ON e.department_id = d.id",
    ).structure
    expect(structure?.selectItems[0]?.expression).toMatchObject({
      kind: 'column', table: 'e', name: 'name',
    })
    expect(structure?.selectItems[1]?.expression).toMatchObject({
      kind: 'column', table: 'd', name: 'department_name',
    })
  })
})

describe('interpretStatement — WHERE conditions', () => {
  it('extracts a simple comparison', () => {
    const where = interpretStatement('SELECT * FROM employees WHERE salary > 50000').structure?.where
    expect(where?.kind).toBe('comparison')
    expect(where).toMatchObject({
      kind: 'comparison',
      operator: '>',
      left: { kind: 'column', name: 'salary' },
      right: { kind: 'literal', value: 50000 },
    })
    expect(where?.text).toBe('salary > 50000')
  })

  it('extracts AND/OR nesting and NOT IS NULL', () => {
    const where = interpretStatement(
      "SELECT * FROM employees WHERE e.city = 'Delhi' AND NOT salary IS NULL",
    ).structure?.where
    expect(where?.kind).toBe('logical')
    expect(where).toMatchObject({ kind: 'logical', operator: 'AND' })
    const right = (where as { right: { kind: string; operator?: string } }).right
    expect(right.kind).toBe('not')
    expect(right.operator).toBeUndefined()
  })

  it('extracts IN with value lists', () => {
    const where = interpretStatement(
      'SELECT * FROM employees WHERE department_id IN (1, 2)',
    ).structure?.where
    expect(where).toMatchObject({ kind: 'comparison', operator: 'IN' })
    const right = (where as { right: { kind: string; values: unknown[] | null } }).right
    expect(right.kind).toBe('list')
    expect(right.values).toEqual([1, 2])
  })

  it('extracts BETWEEN with its two bounds', () => {
    const where = interpretStatement(
      'SELECT * FROM employees WHERE salary BETWEEN 40000 AND 70000',
    ).structure?.where
    expect(where).toMatchObject({ kind: 'comparison', operator: 'BETWEEN' })
    expect(where?.text).toBe('salary BETWEEN 40000 AND 70000')
    const right = (where as { right: { kind: string; values: unknown[] | null } }).right
    expect(right.kind).toBe('list')
    expect(right.values).toEqual([40000, 70000])
  })

  it('extracts IS NULL and IS NOT NULL', () => {
    expect(
      interpretStatement('SELECT * FROM employees WHERE age IS NULL').structure?.where,
    ).toMatchObject({ kind: 'comparison', operator: 'IS' })
    expect(
      interpretStatement('SELECT * FROM employees WHERE age IS NOT NULL').structure?.where,
    ).toMatchObject({ kind: 'comparison', operator: 'IS NOT' })
  })

  it('extracts LIKE', () => {
    const where = interpretStatement(
      "SELECT * FROM employees WHERE name LIKE 'R%'",
    ).structure?.where
    expect(where).toMatchObject({ kind: 'comparison', operator: 'LIKE', right: { value: 'R%' } })
  })
})

describe('interpretStatement — aggregation', () => {
  it('extracts GROUP BY, aggregates and HAVING', () => {
    const structure = interpretStatement(
      'SELECT department_id, COUNT(*) AS total, AVG(salary) FROM employees GROUP BY department_id HAVING AVG(salary) > 50000',
    ).structure
    expect(structure?.groupBy).toHaveLength(1)
    expect(structure?.groupBy[0]).toMatchObject({ kind: 'column', name: 'department_id' })
    expect(structure?.aggregates).toHaveLength(3) // COUNT, AVG in select, AVG in having
    expect(structure?.aggregates[0]).toMatchObject({ name: 'COUNT', argument: null, distinct: false })
    expect(structure?.having).toMatchObject({ kind: 'comparison', operator: '>' })
  })

  it('extracts COUNT(DISTINCT col) with distinct flag', () => {
    const structure = interpretStatement(
      'SELECT COUNT(DISTINCT city) AS cities FROM employees',
    ).structure
    expect(structure?.aggregates[0]).toMatchObject({ name: 'COUNT', distinct: true })
    expect(structure?.aggregates[0]?.argument).toMatchObject({ kind: 'column', name: 'city' })
  })

  it('detects DISTINCT in SELECT DISTINCT', () => {
    const structure = interpretStatement('SELECT DISTINCT city FROM employees').structure
    expect(structure?.distinct).toBe(true)
  })
})

describe('interpretStatement — ORDER BY / LIMIT', () => {
  it('extracts ORDER BY with direction', () => {
    const structure = interpretStatement(
      'SELECT name FROM employees ORDER BY salary DESC, name',
    ).structure
    expect(structure?.orderBy).toEqual([
      { expression: { kind: 'column', table: null, name: 'salary', text: 'salary' }, direction: 'DESC', text: 'salary' },
      { expression: { kind: 'column', table: null, name: 'name', text: 'name' }, direction: 'ASC', text: 'name' },
    ])
  })

  it('extracts LIMIT and OFFSET', () => {
    const structure = interpretStatement(
      'SELECT name FROM employees LIMIT 3 OFFSET 1',
    ).structure
    expect(structure?.limit).toEqual({ limit: 3, offset: 1, text: 'LIMIT 3 OFFSET 1' })

    expect(
      interpretStatement('SELECT name FROM employees LIMIT 5').structure?.limit,
    ).toEqual({ limit: 5, offset: 0, text: 'LIMIT 5' })
  })
})

describe('interpretStatement — joins', () => {
  it('extracts INNER JOIN with ON condition', () => {
    const structure = interpretStatement(
      'SELECT e.name FROM employees e INNER JOIN departments d ON e.department_id = d.id',
    ).structure
    expect(structure?.joins).toHaveLength(1)
    expect(structure?.joins[0]).toMatchObject({
      type: 'INNER JOIN',
      table: { name: 'departments', alias: 'd' },
    })
    expect(structure?.joins[0]?.on).toMatchObject({ kind: 'comparison', operator: '=' })
  })

  it('extracts LEFT JOIN', () => {
    const structure = interpretStatement(
      'SELECT d.department_name FROM departments d LEFT JOIN projects p ON p.department_id = d.id',
    ).structure
    expect(structure?.joins[0]?.type).toBe('LEFT JOIN')
  })
})

describe('interpretStatement — unsupported constructs', () => {
  it('rejects non-SELECT statements', () => {
    const result = interpretStatement('INSERT INTO employees VALUES (1)')
    expect(result.structure).toBeNull()
    expect(result.unsupportedReasons[0]).toMatch(/Only SELECT/i)
  })

  it('rejects unparseable SQL without throwing', () => {
    const result = interpretStatement('SELEC nonsense')
    expect(result.structure).toBeNull()
    expect(result.unsupportedReasons.length).toBeGreaterThan(0)
  })

  it('flags unsupported SELECT expressions but keeps the rest', () => {
    const result = interpretStatement(
      'SELECT ABS(salary) FROM employees',
    )
    // ABS is not in the aggregate set — a plain function call.
    expect(result.unsupportedReasons.length).toBeGreaterThan(0)
  })

  it('rejects comma joins with a clear reason', () => {
    const result = interpretStatement('SELECT * FROM employees, departments')
    expect(result.unsupportedReasons.some((reason) => /comma cross joins/i.test(reason))).toBe(true)
  })
})

describe('interpretQuery — batch handling', () => {
  it('rejects multiple statements with an explanatory reason', () => {
    const result = interpretQuery('SELECT 1; SELECT 2;', ['SELECT 1', 'SELECT 2'])
    expect(result.structure).toBeNull()
    expect(result.unsupportedReasons[0]).toMatch(/Multiple statements/)
  })

  it('rejects an empty batch', () => {
    expect(interpretQuery('   ', []).unsupportedReasons[0]).toMatch(/no SQL statement/i)
  })

  it('interprets a single statement batch', () => {
    const result = interpretQuery('SELECT * FROM employees;', ['SELECT * FROM employees'])
    expect(result.structure?.from.name).toBe('employees')
  })
})
