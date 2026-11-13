import { describe, expect, it } from 'vitest'
import {
  detectStatementType,
  getParseError,
  getReferencedTables,
  isMutatingStatementType,
  parseSql,
} from './sqlParser'

describe('detectStatementType', () => {
  it.each([
    ['SELECT * FROM employees', 'SELECT'],
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET a = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['CREATE TABLE t (id INTEGER)', 'CREATE'],
    ['DROP TABLE t', 'DROP'],
    ['PRAGMA foreign_keys = ON', 'PRAGMA'],
  ])('classifies %s', (sql, expected) => {
    expect(detectStatementType(sql)).toBe(expected)
  })

  it('classifies statements that node-sql-parser cannot parse via keyword fallback', () => {
    expect(detectStatementType('VACUUM')).toBe('VACUUM')
  })

  it('ignores leading comments before the keyword', () => {
    expect(detectStatementType('-- load data\nSELECT 1')).toBe('SELECT')
  })

  it('never throws on garbage', () => {
    expect(detectStatementType(']]] nonsense')).toBe('UNKNOWN')
    expect(detectStatementType('')).toBe('UNKNOWN')
  })
})

describe('isMutatingStatementType', () => {
  it('marks data-changing types as mutating', () => {
    expect(isMutatingStatementType('INSERT')).toBe(true)
    expect(isMutatingStatementType('CREATE')).toBe(true)
    expect(isMutatingStatementType('DROP')).toBe(true)
  })
  it('marks reads as non-mutating', () => {
    expect(isMutatingStatementType('SELECT')).toBe(false)
    expect(isMutatingStatementType('PRAGMA')).toBe(false)
  })
})

describe('parseSql', () => {
  it('returns an AST with a type for valid SQLite', () => {
    const ast = parseSql('SELECT name FROM employees')
    expect(ast).not.toBeNull()
    expect(ast.type).toBe('select')
  })

  it('returns null for invalid SQL without throwing', () => {
    expect(parseSql('SELEC * FRM')).toBeNull()
    expect(parseSql('')).toBeNull()
  })
})

describe('getParseError', () => {
  it('returns a message for invalid SQL and null for valid SQL', () => {
    expect(getParseError('SELECT * FROM employees')).toBeNull()
    expect(getParseError('SELEC nonsense')).toBeTruthy()
  })
})

describe('getReferencedTables', () => {
  it('finds tables in FROM and JOIN clauses via the AST', () => {
    const tables = getReferencedTables(
      'SELECT * FROM employees INNER JOIN departments ON employees.department_id = departments.id',
    )
    expect(tables).toContain('employees')
    expect(tables).toContain('departments')
  })

  it('falls back to regex when the AST is unavailable', () => {
    const tables = getReferencedTables('SELECT x FROM pragma_table_info("t")')
    expect(Array.isArray(tables)).toBe(true)
  })
})
