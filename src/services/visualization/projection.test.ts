import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { SCHEMA_SQL, SEED_SQL } from '../database/seedData'
import { interpretQuery } from './astInterpreter'
import { analyzeCapability } from './capabilityAnalyzer'
import { simulateAndValidate } from './validation'

/**
 * Stage 8B parity tests: projection expansion, output naming and clause
 * aliases must match real SQLite in both columns and rows.
 */

let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(SCHEMA_SQL)
  db.runRaw(SEED_SQL)
})

afterEach(() => {
  db.close()
})

const JOIN = 'FROM employees e JOIN departments d ON e.department_id = d.id'

const PARITY_CASES: Array<{ name: string; sql: string }> = [
  {
    name: 'bare * on a join keeps duplicate SQLite column names',
    sql: `SELECT * ${JOIN} ORDER BY e.id`,
  },
  {
    name: 'table.* expands only the left relation',
    sql: `SELECT e.* ${JOIN} ORDER BY e.id`,
  },
  {
    name: 'table.* expands only the right relation',
    sql: `SELECT d.* ${JOIN} ORDER BY e.id`,
  },
  {
    name: 'two table.* projections expand in order',
    sql: `SELECT e.*, d.* ${JOIN} ORDER BY e.id`,
  },
  {
    name: 'wildcard followed by an explicit column',
    sql: 'SELECT *, id FROM employees ORDER BY id',
  },
  {
    name: 'explicit column followed by a wildcard',
    sql: 'SELECT id, * FROM employees ORDER BY id',
  },
  {
    name: 'table.* mixed with an explicit joined column',
    sql: `SELECT e.*, d.department_name ${JOIN} ORDER BY e.id`,
  },
  {
    name: 'CTE self-join keeps output names from the CTE',
    sql: `WITH x AS (SELECT id, name FROM employees)
          SELECT * FROM x a JOIN x b ON a.id = b.id ORDER BY a.id`,
  },
  {
    name: 'WHERE output alias',
    sql: 'SELECT salary AS pay FROM employees WHERE pay > 70000 ORDER BY pay',
  },
  {
    name: 'GROUP BY output alias',
    sql: 'SELECT department_id AS d, COUNT(*) AS c FROM employees GROUP BY d ORDER BY d',
  },
  {
    name: 'HAVING output alias',
    sql: `SELECT department_id, COUNT(*) AS c
          FROM employees GROUP BY department_id HAVING c > 2 ORDER BY department_id`,
  },
  {
    name: 'HAVING alias containing an aggregate expression',
    sql: `SELECT department_id, SUM(salary) AS total
          FROM employees GROUP BY department_id HAVING total > 100000 ORDER BY department_id`,
  },
  {
    name: 'WHERE prefers a source column over an alias',
    sql: 'SELECT city AS id FROM employees WHERE id = 1',
  },
  {
    name: 'GROUP BY prefers a source column over an alias',
    sql: 'SELECT city AS id, COUNT(*) AS c FROM employees GROUP BY id ORDER BY id',
  },
  {
    name: 'HAVING prefers a source column over an alias',
    sql: "SELECT COUNT(*) AS city FROM employees HAVING city = 'Delhi'",
  },
]

describe('projection and alias parity with SQLite', () => {
  it.each(PARITY_CASES)('$name', ({ sql }) => {
    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
    if (!outcome.simulation.ok) return

    expect(outcome.execution, 'SQLite execution should succeed').not.toBeNull()
    expect(
      outcome.validation?.validated,
      outcome.validation?.detail ?? 'expected SQLite parity',
    ).toBe(true)

    const actualColumns = outcome.execution?.columns ?? []
    expect(outcome.simulation.trace.finalColumns).toEqual(actualColumns)
    expect(outcome.simulation.trace.finalRows.map((row) => row.values)).toEqual(
      outcome.execution?.values ?? [],
    )
  })

  it('rejects an out-of-scope wildcard before simulation', () => {
    const sql = 'SELECT z.* FROM employees'
    const interpretation = interpretQuery(sql, [sql])
    const capability = analyzeCapability(interpretation)
    expect(capability.supported).toBe(false)

    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok).toBe(false)
    expect(outcome.execution).toBeNull()
    expect(outcome.validation).toBeNull()
    if (outcome.simulation.ok) return
    expect(outcome.simulation.reasons.join(' ')).toMatch(/Wildcard "z\.\*"/)
  })

  it('rejects an aliased table original name before simulation', () => {
    const sql = 'SELECT employees.* FROM employees e'
    const capability = analyzeCapability(interpretQuery(sql, [sql]))
    expect(capability.supported).toBe(false)

    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok).toBe(false)
    expect(outcome.execution).toBeNull()
    expect(outcome.validation).toBeNull()
    if (outcome.simulation.ok) return
    expect(outcome.simulation.reasons.join(' ')).toMatch(/aliased as "e"/)
  })

  it('keeps capability and simulation aligned for mixed wildcards and aliases', () => {
    const queries = [
      `SELECT e.*, d.* ${JOIN}`,
      'SELECT *, id FROM employees',
      'SELECT salary AS pay FROM employees WHERE pay > 70000',
      'SELECT department_id AS d, COUNT(*) AS c FROM employees GROUP BY d',
      'SELECT department_id, COUNT(*) AS c FROM employees GROUP BY department_id HAVING c > 1',
    ]
    for (const sql of queries) {
      const capability = analyzeCapability(interpretQuery(sql, [sql]))
      expect(capability.supported, sql).toBe(true)
      expect(simulateAndValidate(sql, [sql], db).simulation.ok, sql).toBe(true)
    }
  })
})
