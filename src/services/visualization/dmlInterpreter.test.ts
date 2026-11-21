import { describe, expect, it } from 'vitest'
import { interpretDml } from './dmlInterpreter'

function supported(sql: string) {
  const result = interpretDml([sql])
  expect(result.supported, result.supported ? '' : result.reasons.join('; ')).toBe(true)
  if (!result.supported) throw new Error('Expected supported DML')
  return result.statement
}

function rejected(sql: string, pattern?: RegExp) {
  const result = interpretDml([sql])
  expect(result.supported).toBe(false)
  if (result.supported) throw new Error('Expected unsupported DML')
  if (pattern !== undefined) expect(result.reasons.join(' ')).toMatch(pattern)
}

describe('central DML capability classification', () => {
  it.each([
    "INSERT INTO employees (name) VALUES ('Alice')",
    "INSERT INTO employees (name) VALUES ('Alice'), ('Bob')",
    'INSERT INTO employees SELECT name FROM applicants',
    'INSERT INTO employees DEFAULT VALUES',
    'UPDATE employees SET department_id = department_id + 1 WHERE id = 5',
    'DELETE FROM employees WHERE id IN (1, 2, 3)',
    'DELETE FROM employees',
  ])('classifies the supported subset: %s', (sql) => {
    expect(['INSERT', 'UPDATE', 'DELETE']).toContain(supported(sql).kind)
  })

  it('preserves the original INSERT source SELECT spelling', () => {
    const statement = supported('INSERT INTO employees (name) SELECT name FROM applicants WHERE id >= 2')
    expect(statement.kind).toBe('INSERT')
    if (statement.kind !== 'INSERT' || statement.input.kind !== 'SELECT') throw new Error('Expected INSERT SELECT')
    expect(statement.input.sql).toBe('SELECT name FROM applicants WHERE id >= 2')
  })

  it.each([
    "INSERT OR REPLACE INTO employees (name) VALUES ('Alice')",
    "INSERT INTO employees (name) VALUES ('Alice') ON CONFLICT(name) DO UPDATE SET name = 'Bob'",
    "INSERT INTO employees (name) VALUES ('Alice') RETURNING id",
    'UPDATE employees SET name = ABS(id)',
    'UPDATE employees SET name = (SELECT name FROM other) WHERE id = 1',
    'UPDATE employees SET name = \'x\' WHERE id = 1 ORDER BY id LIMIT 1',
    'DELETE FROM employees WHERE id IN (SELECT id FROM other)',
    'DELETE FROM employees RETURNING id',
  ])('rejects unsupported input before execution: %s', (sql) => {
    rejected(sql)
  })

  it('rejects multiple DML statements before execution', () => {
    expect(interpretDml(['UPDATE employees SET id = 2 WHERE id = 1', 'DELETE FROM employees']).supported).toBe(false)
  })

  it('rejects empty, non-DML, and malformed input', () => {
    expect(interpretDml([]).supported).toBe(false)
    rejected('SELECT * FROM employees', /Only SELECT and supported/i)
    rejected('UPDATE employees SET WHERE', /parsed|visualizable/i)
  })
})
