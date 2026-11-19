import { beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { SCHEMA_SQL, SEED_SQL } from '../database/seedData'
import {
  compareSimulationWithSqlite,
  simulateAndValidate,
} from './validation'

/**
 * SQLite parity tests (Stage 2 Milestone 4): the logical simulator's
 * final result must match the real SQLite (WASM) result for every
 * supported query. These run real SQLite in Node — no mocks.
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

/** The seven example queries from the Stage 2 specification. */
const SPEC_QUERIES = [
  'SELECT * FROM employees WHERE salary > 50000',
  'SELECT department_id, COUNT(*) FROM employees GROUP BY department_id',
  'SELECT department_id, AVG(salary) AS average_salary FROM employees GROUP BY department_id HAVING AVG(salary) > 50000',
  'SELECT DISTINCT city FROM employees ORDER BY city',
  'SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 3',
  'SELECT department_id, COUNT(*) AS total FROM employees WHERE age > 25 GROUP BY department_id ORDER BY total DESC',
  'SELECT name, salary FROM employees WHERE salary BETWEEN 40000 AND 70000 AND department_id IN (1, 2) ORDER BY salary DESC',
]

describe('simulateAndValidate — scalar subqueries against real SQLite', () => {
  /** Seed AVG(salary) is 53125; only Priya, Neha and Arjun earn more. */
  it('validates a scalar subquery in WHERE', () => {
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values).toEqual([['Arjun'], ['Neha'], ['Priya']])
    if (outcome.validation && !outcome.validation.validated) {
      throw new Error(`parity failure: ${outcome.validation.detail}`)
    }
  })

  it('validates a scalar subquery in the SELECT list', () => {
    const query =
      'SELECT name, (SELECT MAX(salary) FROM employees) AS top_salary FROM employees ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values.every((row) => row[1] === 90000)).toBe(true)
  })

  it('validates an empty subquery result as NULL (outer rows filtered out)', () => {
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT id FROM employees WHERE id > 999) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values).toEqual([])
    expect(outcome.simulation.ok && outcome.simulation.trace.nestedQueries?.[0]?.finalRows).toHaveLength(0)
  })

  it('validates a NULL scalar value from a non-empty subquery', () => {
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT NULL FROM employees WHERE id = 1) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values).toEqual([])
  })

  it('validates SQLite’s first-row rule for a multi-row scalar subquery', () => {
    const query =
      'SELECT name, (SELECT name FROM employees ORDER BY id DESC) AS any_name FROM employees ORDER BY id LIMIT 1'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values).toEqual([['Rahul', 'Pooja']])
  })

  it('validates a subquery nested inside another subquery', () => {
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees WHERE salary > (SELECT MIN(salary) FROM employees)) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    if (outcome.validation && !outcome.validation.validated) {
      throw new Error(`parity failure: ${outcome.validation.detail}`)
    }
  })

  it('rejects a correlated scalar subquery without executing it', () => {
    const query =
      'SELECT name FROM employees e WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.department_id = e.department_id) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(false)
    if (!outcome.simulation.ok) {
      expect(outcome.simulation.reasons.some((reason) => /correlated/i.test(reason))).toBe(true)
    }
    expect(outcome.execution).toBeNull()
    expect(outcome.validation).toBeNull()
  })

  it('reports a multi-column scalar subquery instead of faking a value', () => {
    // node-sql-parser rejects a multi-column subquery in the SELECT list,
    // but parses one in WHERE — where SQLite rejects it at execution time.
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT id, name FROM employees WHERE id = 1)'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(false)
    if (!outcome.simulation.ok) {
      expect(outcome.simulation.reasons.some((reason) => /2 columns/i.test(reason))).toBe(true)
    }
    // SQLite itself rejects this query, so there is no real result to validate.
    expect(outcome.execution).toBeNull()
    expect(outcome.validation).toBeNull()
  })
})

describe('simulateAndValidate — spec queries against real SQLite', () => {
  for (const query of SPEC_QUERIES) {
    it(`validates: ${query}`, () => {
      const outcome = simulateAndValidate(query, [query], db)
      expect(outcome.simulation.ok).toBe(true)
      if (!outcome.simulation.ok) {
        throw new Error(`simulation failed: ${outcome.simulation.reasons.join('; ')}`)
      }
      expect(outcome.execution).not.toBeNull()
      expect(outcome.validation?.validated).toBe(true)
      if (outcome.validation && !outcome.validation.validated) {
        throw new Error(`parity failure: ${outcome.validation.detail}`)
      }
    })
  }
})

describe('simulateAndValidate — additional supported combinations', () => {
  it('validates LIKE / IS NULL / NOT with SQLite 3VL', () => {
    const outcome = simulateAndValidate(
      "SELECT name, city FROM employees WHERE name LIKE '%a%' AND NOT city IS NULL ORDER BY name",
      ["SELECT name, city FROM employees WHERE name LIKE '%a%' AND NOT city IS NULL ORDER BY name"],
      db,
    )
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
  })

  it('validates an INNER JOIN with ORDER BY on qualified columns', () => {
    const query =
      'SELECT e.name, d.department_name FROM employees e INNER JOIN departments d ON e.department_id = d.id ORDER BY e.name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    if (outcome.validation && !outcome.validation.validated) {
      throw new Error(`parity failure: ${outcome.validation.detail}`)
    }
  })

  it('validates arithmetic projections and aliases', () => {
    const query =
      'SELECT name, salary * 2 + 1000 AS adjusted FROM employees ORDER BY adjusted DESC LIMIT 2'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
  })

  it('validates COUNT(DISTINCT …) and MIN/MAX', () => {
    const query =
      'SELECT department_id, COUNT(DISTINCT city) AS cities, MIN(salary), MAX(salary) FROM employees GROUP BY department_id ORDER BY department_id'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
  })

  it('validates empty results', () => {
    const query = 'SELECT name FROM employees WHERE salary > 999999 ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values).toEqual([])
  })

  it('validates aggregate over an empty set (COUNT 0, SUM NULL)', () => {
    const query = 'SELECT COUNT(*) AS c, SUM(salary) AS s, AVG(salary) AS a FROM employees WHERE salary > 999999'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.execution?.values[0]).toEqual([0, null, null])
  })

  it('validates SELECT * via INNER JOIN and LIMIT with OFFSET', () => {
    const query =
      'SELECT e.name, p.project_name FROM employees e INNER JOIN employee_projects ep ON ep.employee_id = e.id INNER JOIN projects p ON p.id = ep.project_id ORDER BY e.name, p.project_name LIMIT 4 OFFSET 2'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
  })

  it('does not execute queries the simulator cannot interpret', () => {
    const outcome = simulateAndValidate('SELECT ABS(salary) FROM employees', ['SELECT ABS(salary) FROM employees'], db)
    expect(outcome.simulation.ok).toBe(false)
    expect(outcome.execution).toBeNull()
    expect(outcome.validation).toBeNull()
  })
})

describe('compareSimulationWithSqlite — failure reporting', () => {
  it('detects column count mismatches', () => {
    const fakeTrace = {
      finalColumns: ['a', 'b'],
      finalRows: [],
      hasDeterministicOrder: false,
    }
    const result = compareSimulationWithSqlite(fakeTrace, { columns: ['a'], values: [] })
    expect(result.validated).toBe(false)
    expect(result.detail).toMatch(/Column count/)
  })

  it('detects column name mismatches leniently (case/whitespace insensitive)', () => {
    const fakeTrace = { finalColumns: ['Total Count'], finalRows: [], hasDeterministicOrder: false }
    const lenient = compareSimulationWithSqlite(fakeTrace, { columns: ['total  count'], values: [] })
    expect(lenient.validated).toBe(true)

    const strict = compareSimulationWithSqlite(fakeTrace, { columns: ['other'], values: [] })
    expect(strict.validated).toBe(false)
    expect(strict.detail).toMatch(/Column name/)
  })

  it('detects row count mismatches', () => {
    const fakeTrace = {
      finalColumns: ['a'],
      finalRows: [{ id: 'r1', values: [1] }, { id: 'r2', values: [2] }],
      hasDeterministicOrder: false,
    }
    const result = compareSimulationWithSqlite(fakeTrace, { columns: ['a'], values: [[1]] })
    expect(result.validated).toBe(false)
    expect(result.detail).toMatch(/Row count/)
  })

  it('detects differing rows in ordered comparison', () => {
    const fakeTrace = {
      finalColumns: ['a'],
      finalRows: [{ id: 'r1', values: [1] }, { id: 'r2', values: [3] }],
      hasDeterministicOrder: true,
    }
    const result = compareSimulationWithSqlite(fakeTrace, { columns: ['a'], values: [[1], [2]] })
    expect(result.validated).toBe(false)
    expect(result.method).toBe('ordered')
    expect(result.detail).toMatch(/Row 2/)
  })

  it('unordered comparison ignores row order but not multiplicity', () => {
    const fakeTrace = {
      finalColumns: ['a'],
      finalRows: [{ id: 'r1', values: [1] }, { id: 'r2', values: [2] }],
      hasDeterministicOrder: false,
    }
    const reordered = compareSimulationWithSqlite(fakeTrace, { columns: ['a'], values: [[2], [1]] })
    expect(reordered.validated).toBe(true)

    const duplicated = compareSimulationWithSqlite(fakeTrace, { columns: ['a'], values: [[1], [1]] })
    expect(duplicated.validated).toBe(false)
  })

  it('compares floats with a relative tolerance and NULLs as equal', () => {
    const fakeTrace = {
      finalColumns: ['v', 'n'],
      finalRows: [{ id: 'r1', values: [51333.33333333, null] }],
      hasDeterministicOrder: false,
    }
    const result = compareSimulationWithSqlite(fakeTrace, {
      columns: ['v', 'n'],
      values: [[51333.33333332, null]],
    })
    expect(result.validated).toBe(true)
  })
})
