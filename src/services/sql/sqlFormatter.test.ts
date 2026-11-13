import { describe, expect, it } from 'vitest'
import { formatSQL, summarizeSQL } from './sqlFormatter'

describe('formatSQL', () => {
  it('uppercases keywords and breaks major clauses onto lines', () => {
    const result = formatSQL(
      'select name, salary from employees where salary > 40000 order by salary desc',
    )
    expect(result).toContain('SELECT name,')
    expect(result).toContain('  salary')
    expect(result).toContain('FROM employees')
    expect(result).toContain('WHERE salary > 40000')
    expect(result).toContain('ORDER BY salary DESC')
  })

  it('preserves identifier casing', () => {
    const result = formatSQL('select department_name from departments')
    expect(result).toContain('department_name')
    expect(result).not.toContain('DEPARTMENT_NAME')
  })

  it('preserves string literals exactly', () => {
    const result = formatSQL("select * from t where name = 'Rahul'")
    expect(result).toContain("'Rahul'")
  })

  it('handles joins with ON at an indent', () => {
    const result = formatSQL(
      'select * from employees inner join departments on employees.department_id = departments.id',
    )
    expect(result).toContain('INNER JOIN departments')
    expect(result).toMatch(/  ON employees/)
  })

  it('handles GROUP BY and HAVING', () => {
    const result = formatSQL(
      'select department_id, avg(salary) from employees group by department_id having avg(salary) > 40000',
    )
    expect(result).toContain('GROUP BY department_id')
    expect(result).toContain('HAVING AVG(salary) > 40000')
  })

  it('formats a formatted query idempotently', () => {
    const once = formatSQL(
      'SELECT department_id, AVG(salary) FROM employees GROUP BY department_id HAVING AVG(salary) > 40000',
    )
    expect(formatSQL(once.trim())).toBe(once.trim() + '\n')
  })

  it('never throws on garbage', () => {
    expect(() => formatSQL('((( SELECT broken')).not.toThrow()
    expect(() => formatSQL('')).not.toThrow()
  })

  it('returns empty input unchanged', () => {
    expect(formatSQL('')).toBe('')
    expect(formatSQL('   ')).toBe('   ')
  })
})

describe('summarizeSQL', () => {
  it('collapses whitespace', () => {
    expect(summarizeSQL('SELECT\n  *\nFROM\n  t')).toBe('SELECT * FROM t')
  })
  it('truncates long queries with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const result = summarizeSQL(long, 40)
    expect(result.length).toBeLessThanOrEqual(40)
    expect(result.endsWith('…')).toBe(true)
  })
})
