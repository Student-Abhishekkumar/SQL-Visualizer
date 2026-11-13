import { beforeEach, describe, expect, it } from 'vitest'
import {
  SqlExecutionError,
  SQLiteDatabase,
  hasExecutableSql,
} from './sqliteService'
import { SCHEMA_SQL, SEED_SQL } from './seedData'

/**
 * Integration tests: run real SQLite (WASM) in Node against the
 * seeded University Database.
 */

async function createSeededDb(): Promise<SQLiteDatabase> {
  const db = await SQLiteDatabase.create()
  db.runRaw(SCHEMA_SQL)
  db.runRaw(SEED_SQL)
  return db
}

let db: SQLiteDatabase

beforeEach(async () => {
  db = await createSeededDb()
})

describe('SQLiteDatabase.create', () => {
  it('starts empty and can restore from a snapshot', async () => {
    const fresh = await SQLiteDatabase.create()
    expect(fresh.queryAll("SELECT name FROM sqlite_master WHERE type='table'").values).toEqual([])

    const snapshot = db.exportSnapshot()
    const restored = await SQLiteDatabase.create(undefined, snapshot)
    expect(restored.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)
    restored.close()
  })

  it('enforces foreign keys on new connections', async () => {
    expect(() => db.runRaw("INSERT INTO employees VALUES (99, 'X', 999, 1, 1, 'X')"))
      .toThrow(/FOREIGN KEY/)
  })

  it('reports the SQLite version', () => {
    expect(db.sqliteVersion()).toMatch(/^\d+\.\d+/)
  })
})

describe('executeBatch — reads', () => {
  it('executes a SELECT and returns columns/rows', () => {
    const [result] = db.executeBatch('SELECT * FROM employees ORDER BY id')
    expect(result?.columns).toEqual([
      'id', 'name', 'department_id', 'salary', 'age', 'city',
    ])
    expect(result?.rowCount).toBe(8)
    expect(result?.values[0]).toEqual([1, 'Rahul', 1, 45000, 23, 'Delhi'])
    expect(result?.statementType).toBe('SELECT')
    expect(result?.hasResultSet).toBe(true)
    expect(result?.executionTime).toBeGreaterThanOrEqual(0)
  })

  it('supports WHERE / ORDER BY / GROUP BY / HAVING / LIMIT / OFFSET / DISTINCT', () => {
    expect(db.executeBatch('SELECT * FROM employees WHERE salary > 40000')[0]?.rowCount).toBe(5)

    const ordered = db.executeBatch('SELECT name FROM employees ORDER BY salary DESC LIMIT 2')[0]
    expect(ordered?.values.map((row) => row[0])).toEqual(['Arjun', 'Neha'])

    expect(db.executeBatch('SELECT DISTINCT city FROM employees')[0]?.rowCount).toBe(6)

    const grouped = db.executeBatch(
      'SELECT department_id, AVG(salary) FROM employees GROUP BY department_id HAVING AVG(salary) > 40000',
    )[0]
    // All three departments average above 40000 (54333 / 50667 / 55000).
    expect(grouped?.rowCount).toBe(3)
  })

  it('supports INNER and LEFT JOINs', () => {
    const inner = db.executeBatch(
      'SELECT employees.name, departments.department_name FROM employees INNER JOIN departments ON employees.department_id = departments.id',
    )[0]
    expect(inner?.rowCount).toBe(8)

    const left = db.executeBatch(
      'SELECT departments.department_name, projects.project_name FROM departments LEFT JOIN projects ON projects.department_id = departments.id',
    )[0]
    expect(left?.rowCount).toBeGreaterThanOrEqual(3)
  })

  it('supports subqueries', () => {
    const result = db.executeBatch(
      'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees)',
    )[0]
    expect(result?.rowCount).toBe(3)
  })

  it('returns an empty result set (not an error) for zero matching rows', () => {
    const [result] = db.executeBatch(
      'SELECT * FROM employees WHERE salary > 1000000',
    )
    expect(result?.rowCount).toBe(0)
    expect(result?.columns.length).toBeGreaterThan(0)
  })
})

describe('executeBatch — writes', () => {
  it('reports rowsModified for INSERT/UPDATE/DELETE', () => {
    const insert = db.executeBatch(
      "INSERT INTO employees (id, name, department_id, salary, age, city) VALUES (9, 'Vikram', 1, 55000, 24, 'Jaipur')",
    )[0]
    expect(insert?.rowsModified).toBe(1)
    expect(insert?.hasResultSet).toBe(false)

    const update = db.executeBatch("UPDATE employees SET salary = 1 WHERE id = 9")[0]
    expect(update?.rowsModified).toBe(1)

    const del = db.executeBatch('DELETE FROM employees WHERE id = 9')[0]
    expect(del?.rowsModified).toBe(1)
  })

  it('does not report rowsModified for SELECT', () => {
    const [select] = db.executeBatch('SELECT * FROM employees')
    expect(select?.rowsModified).toBeNull()
  })

  it('handles DDL (CREATE, DROP) with foreign key enforcement intact', () => {
    db.executeBatch('CREATE TABLE clubs (id INTEGER PRIMARY KEY, club_name TEXT)')
    const [select] = db.executeBatch('SELECT COUNT(*) FROM clubs')
    expect(select?.values[0]?.[0]).toBe(0)
    db.executeBatch('DROP TABLE clubs')
    expect(() => db.queryAll('SELECT * FROM clubs')).toThrow()
  })

  it('surfaces UNIQUE / constraint violations as errors', () => {
    expect(() =>
      db.executeBatch('INSERT INTO departments (id, department_name, location) VALUES (1, "Dupe", "X")'),
    ).toThrow(SqlExecutionError)
  })
})

describe('executeBatch — multiple statements', () => {
  it('executes statements sequentially and returns each result', () => {
    const results = db.executeBatch(
      'SELECT COUNT(*) FROM employees; INSERT INTO departments (id, department_name, location) VALUES (4, "Finance", "Pune"); SELECT COUNT(*) FROM departments;',
    )
    expect(results).toHaveLength(3)
    expect(results[0]?.values[0]?.[0]).toBe(8)
    expect(results[1]?.rowsModified).toBe(1)
    expect(results[2]?.values[0]?.[0]).toBe(4)
  })

  it('stops at the first failing statement', () => {
    try {
      db.executeBatch('SELECT 1; SELECT * FROM missing_table; SELECT 2;')
      expect.unreachable('expected an error')
    } catch (error) {
      expect(error).toBeInstanceOf(SqlExecutionError)
      expect((error as SqlExecutionError).statementIndex).toBe(1)
      expect((error as SqlExecutionError).message).toMatch(/missing_table|no such table/i)
    }
  })
})

describe('error handling', () => {
  it('reports invalid SQL with the failing statement index', () => {
    try {
      db.executeBatch('SELEC nonsense')
      expect.unreachable('expected an error')
    } catch (error) {
      expect(error).toBeInstanceOf(SqlExecutionError)
      expect((error as SqlExecutionError).statementIndex).toBe(0)
    }
  })

  it('reports queries against nonexistent tables', () => {
    expect(() => db.executeBatch('SELECT * FROM not_a_table')).toThrow(/no such table/i)
  })
})

describe('snapshot round-trip after writes', () => {
  it('persists inserted data through export/restore', async () => {
    db.executeBatch(
      "INSERT INTO employees (id, name, department_id, salary, age, city) VALUES (9, 'Vikram', 1, 55000, 24, 'Jaipur')",
    )
    const restored = await SQLiteDatabase.create(undefined, db.exportSnapshot())
    expect(restored.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(9)
    restored.close()
  })
})

describe('hasExecutableSql', () => {
  it('detects executable vs empty input', () => {
    expect(hasExecutableSql('SELECT 1;')).toBe(true)
    expect(hasExecutableSql('  -- nothing here')).toBe(false)
    expect(hasExecutableSql('')).toBe(false)
  })
})
