import { beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { SCHEMA_SQL, SEED_SQL } from '../database/seedData'
import type { NestedQueryTrace, VisualizationTrace } from '../../types/visualization'
import { simulateAndValidate, validateNestedBlocks } from './validation'

/**
 * Per-CTE parity.
 *
 * A CTE block is validated through a reconstructed `WITH … SELECT * FROM
 * <cte>` statement, so explicit column lists and prerequisite CTEs are
 * real SQL. A CTE mismatch is reported on that block, separately from the
 * outer query's own validation.
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

function cteBlock(overrides: Partial<NestedQueryTrace> = {}): NestedQueryTrace {
  return {
    id: 'q2',
    kind: 'cte',
    label: 'CTE high · high salaries',
    sql: 'SELECT id, name FROM employees WHERE salary > 55000',
    cteName: 'high',
    cteColumns: null,
    dependencies: [],
    stageSnapshots: [],
    finalColumns: ['id', 'name'],
    finalRows: [
      { id: 'q2#r1', values: [2, 'Priya'] },
      { id: 'q2#r2', values: [4, 'Neha'] },
      { id: 'q2#r3', values: [7, 'Arjun'] },
    ],
    parentStage: null,
    consumingStage: null,
    parentId: 'q1',
    depth: 1,
    correlated: false,
    status: 'complete',
    hasDeterministicOrder: false,
    ...overrides,
  }
}

function traceWith(blocks: NestedQueryTrace[]): VisualizationTrace {
  return { nestedQueries: blocks } as unknown as VisualizationTrace
}

describe('validateNestedBlocks — CTE blocks', () => {
  it('validates a CTE whose simulated rows match SQLite', () => {
    const results = validateNestedBlocks(traceWith([cteBlock()]), db)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ blockId: 'q2', validated: true, method: 'unordered' })
    expect(results[0]?.skipped).toBeUndefined()
  })

  it('reports a CTE mismatch on that block, not as an outer failure', () => {
    const wrong = cteBlock({ finalRows: [{ id: 'q2#r1', values: [1, 'Rahul'] }] })
    const results = validateNestedBlocks(traceWith([wrong]), db)
    expect(results[0]?.blockId).toBe('q2')
    expect(results[0]?.validated).toBe(false)
    expect(results[0]?.detail).toMatch(/differs|Row/i)
  })

  it('never reports a truncated CTE as validated', () => {
    const results = validateNestedBlocks(traceWith([cteBlock({ truncated: true })]), db)
    expect(results[0]).toMatchObject({ blockId: 'q2', validated: false, skipped: true })
    expect(results[0]?.detail).toMatch(/capped/i)
  })

  it('never reports a block that read an incomplete CTE as validated', () => {
    const base = cteBlock({
      incomplete: true,
      incompleteReasons: ['"employees" was capped at 3 of 8 rows for visualization.'],
    })
    const named = cteBlock({
      id: 'q3',
      label: 'CTE named · short names',
      sql: 'SELECT id, name FROM high WHERE id < 5',
      cteName: 'named',
      finalRows: [{ id: 'q3#r1', values: [2, 'Priya'] }],
      dependencies: [{ blockId: 'q2', stage: 'FROM' }],
      incomplete: true,
      incompleteReasons: ['Reads incomplete CTE "high": its result was capped for display'],
    })
    const results = validateNestedBlocks(traceWith([base, named]), db)
    expect(results.map((entry) => entry.validated)).toEqual([false, false])
    expect(results.every((entry) => entry.skipped === true)).toBe(true)
    expect(results[1]).toMatchObject({ blockId: 'q3', incomplete: true })
    expect(results[1]?.detail).toMatch(/incomplete/i)
  })

  it('reconstructs explicit CTE column names for validation', () => {
    const block = cteBlock({
      sql: 'SELECT id, name FROM employees WHERE id <= 2',
      cteName: 'summary',
      cteColumns: ['employee_id', 'employee_name'],
      finalColumns: ['employee_id', 'employee_name'],
      finalRows: [
        { id: 'q2#r1', values: [1, 'Rahul'] },
        { id: 'q2#r2', values: [2, 'Priya'] },
      ],
    })
    const results = validateNestedBlocks(traceWith([block]), db)
    expect(results[0]?.validated).toBe(true)
  })

  it('re-declares prerequisite CTEs when validating a dependent CTE', () => {
    const high = cteBlock()
    const named = cteBlock({
      id: 'q3',
      label: 'CTE named · short names',
      sql: 'SELECT id, name FROM high WHERE id < 5',
      cteName: 'named',
      finalColumns: ['id', 'name'],
      finalRows: [
        { id: 'q3#r1', values: [2, 'Priya'] },
        { id: 'q3#r2', values: [4, 'Neha'] },
      ],
      dependencies: [{ blockId: 'q2', stage: 'FROM' }],
    })
    const results = validateNestedBlocks(traceWith([high, named]), db)
    expect(results.map((entry) => entry.blockId)).toEqual(['q2', 'q3'])
    expect(results.every((entry) => entry.validated)).toBe(true)
  })
})

describe('simulateAndValidate — CTE parity integration', () => {
  it('validates the outer result and its single CTE', () => {
    const query = `WITH department_totals AS (
      SELECT department_id, COUNT(*) AS employee_count
      FROM employees
      WHERE department_id IS NOT NULL
      GROUP BY department_id
    )
    SELECT * FROM department_totals ORDER BY department_id`
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.validation?.nested).toHaveLength(1)
    expect(outcome.validation?.nested?.[0]).toMatchObject({
      blockId: 'q2',
      validated: true,
    })
  })

  it('validates chained CTEs independently', () => {
    const query = `WITH high AS (
      SELECT id, name, salary FROM employees WHERE salary > 55000
    ), named AS (
      SELECT id, name FROM high WHERE id < 5
    )
    SELECT * FROM named ORDER BY id`
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.validation?.nested?.map((entry) => entry.blockId)).toEqual(['q2', 'q3'])
    expect(outcome.validation?.nested?.every((entry) => entry.validated)).toBe(true)
  })

  it('validates a CTE with an explicit column list', () => {
    const query = `WITH summary(employee_id, employee_name) AS (
      SELECT id, name FROM employees WHERE id <= 2
    )
    SELECT * FROM summary ORDER BY employee_id`
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.validation?.nested?.[0]?.validated).toBe(true)
  })

  it('validates a CTE that contains a scalar subquery', () => {
    const query = `WITH enriched AS (
      SELECT id, salary, (SELECT MAX(salary) FROM employees) AS top_salary
      FROM employees WHERE id <= 2
    )
    SELECT * FROM enriched ORDER BY id`
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    const nested = outcome.validation?.nested ?? []
    expect(nested.map((entry) => entry.blockId)).toEqual(['q2', 'q3'])
    expect(nested.every((entry) => entry.validated)).toBe(true)
  })

  it('never reports a capped-but-matching outer result as validated', () => {
    const query = 'SELECT id FROM employees ORDER BY id LIMIT 2'
    // SQLite returns ids 1 and 2; the simulator (capped at 3 source rows)
    // also returns ids 1 and 2, but it never saw the complete relation.
    const outcome = simulateAndValidate(query, [query], db, { maxRows: 3 })
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.execution?.values).toHaveLength(2)
    expect(outcome.validation?.validated).toBe(false)
    expect(outcome.validation?.incomplete).toBe(true)
    expect(outcome.validation?.incompleteReasons?.length ?? 0).toBeGreaterThan(0)
  })

  it('does not validate a query with WITH RECURSIVE', () => {
    const query = `WITH RECURSIVE r AS (
      SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3
    ) SELECT * FROM r`
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) return
    expect(outcome.simulation.reasons.join(' ')).toMatch(/recursive/i)
    expect(outcome.validation).toBeNull()
  })
})
