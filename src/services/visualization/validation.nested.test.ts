import { beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { SCHEMA_SQL, SEED_SQL } from '../database/seedData'
import type { NestedQueryTrace, VisualizationTrace } from '../../types/visualization'
import { simulateAndValidate, validateNestedBlocks } from './validation'

/**
 * Per-block parity: every simulated scalar subquery is checked against
 * SQLite independently. A nested mismatch must be distinguishable from
 * the outer result, and a truncated/unexecutable block must never be
 * reported as validated.
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

function baseBlock(overrides: Partial<NestedQueryTrace> = {}): NestedQueryTrace {
  return {
    id: 'q2',
    kind: 'scalar',
    label: 'Scalar subquery · MIN(salary)',
    sql: 'SELECT MIN(salary) FROM employees',
    stageSnapshots: [],
    finalColumns: ['MIN(salary)'],
    finalRows: [{ id: 'q2#r1', values: [28000] }],
    parentStage: 'WHERE',
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

describe('validateNestedBlocks', () => {
  it('validates a nested block that matches SQLite', () => {
    const results = validateNestedBlocks(traceWith([baseBlock()]), db)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ blockId: 'q2', validated: true, method: 'unordered' })
    expect(results[0]?.skipped).toBeUndefined()
  })

  it('reports a nested mismatch with block identity and detail', () => {
    const wrong = baseBlock({ finalRows: [{ id: 'q2#r1', values: [1] }] })
    const results = validateNestedBlocks(traceWith([wrong]), db)
    expect(results[0]?.blockId).toBe('q2')
    expect(results[0]?.validated).toBe(false)
    expect(results[0]?.detail).toMatch(/differs|Row/i)
  })

  it('never reports a truncated nested block as validated', () => {
    const results = validateNestedBlocks(traceWith([baseBlock({ truncated: true })]), db)
    expect(results[0]).toMatchObject({ blockId: 'q2', validated: false, skipped: true })
    expect(results[0]?.detail).toMatch(/capped/i)
  })

  it('reports unsupported blocks instead of silently passing', () => {
    const results = validateNestedBlocks(
      traceWith([
        baseBlock({
          status: 'unsupported',
          unavailableReasons: ['Subquery uses an unsupported construct.'],
        }),
      ]),
      db,
    )
    expect(results[0]).toMatchObject({ validated: false, skipped: true })
    expect(results[0]?.detail).toContain('unsupported')
  })

  it('reports SQLite’s inability to isolate a block as a limitation', () => {
    const results = validateNestedBlocks(
      traceWith([baseBlock({ sql: 'SELECT nope FROM nowhere' })]),
      db,
    )
    expect(results[0]).toMatchObject({ validated: false, skipped: true })
    expect(results[0]?.detail).toMatch(/could not execute/i)
  })
})

describe('simulateAndValidate — nested parity integration', () => {
  it('validates both the outer result and its scalar subquery block', () => {
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(outcome.validation?.nested).toHaveLength(1)
    expect(outcome.validation?.nested?.[0]).toMatchObject({
      blockId: 'q2',
      validated: true,
    })
  })

  it('validates one entry per nested block', () => {
    const query =
      'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees) AND age > (SELECT MIN(age) FROM employees) ORDER BY name'
    const outcome = simulateAndValidate(query, [query], db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.nested?.map((entry) => entry.blockId)).toEqual(['q2', 'q3'])
    expect(outcome.validation?.nested?.every((entry) => entry.validated)).toBe(true)
  })
})
