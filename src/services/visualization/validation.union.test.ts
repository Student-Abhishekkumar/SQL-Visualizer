import { beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'

/**
 * SQLite parity for UNION / UNION ALL.
 *
 * The seeded tables deliberately contain duplicate rows and NULLs, so
 * UNION duplicate elimination (NULL included), UNION ALL preservation,
 * left-associative folding, compound ORDER BY / LIMIT and independent
 * branch parity are all compared with SQLite itself.
 */

let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE u1 (id INTEGER, label TEXT);
    CREATE TABLE u2 (id INTEGER, label TEXT);
    INSERT INTO u1 (id, label) VALUES
      (1, 'a'), (2, 'b'), (NULL, 'n'), (2, 'b');
    INSERT INTO u2 (id, label) VALUES
      (2, 'b'), (3, 'c'), (NULL, 'n');
  `)
})

function parity(sql: string) {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, JSON.stringify(outcome.simulation)).toBe(true)
  expect(outcome.execution).not.toBeNull()
  expect(outcome.validation?.validated, outcome.validation?.detail).toBe(true)
  return outcome
}

describe('UNION SQLite parity', () => {
  it('removes duplicate rows and keeps one NULL row', () => {
    const outcome = parity(
      'SELECT id, label FROM u1 UNION SELECT id, label FROM u2 ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([
      [null, 'n'],
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ])
    expect(outcome.simulation.ok && outcome.simulation.trace.finalRows).toHaveLength(4)
  })

  it('validates each SELECT branch independently against SQLite', () => {
    const outcome = parity('SELECT id FROM u1 UNION SELECT id FROM u2 ORDER BY id')
    const blocks = outcome.validation?.nested ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks.map((block) => block.blockId)).toEqual(['q2', 'q3'])
    expect(blocks.every((block) => block.validated)).toBe(true)
  })

  it('honors a compound alias and LIMIT after sorting', () => {
    const outcome = parity(
      'SELECT id AS key FROM u1 UNION SELECT id FROM u2 ORDER BY key DESC LIMIT 3',
    )
    expect(outcome.execution?.values).toEqual([[3], [2], [1]])
  })

  it('resolves CTE references from every compound branch', () => {
    const outcome = parity(
      `WITH x AS (SELECT id FROM u1 WHERE id IS NOT NULL)
       SELECT id FROM x UNION SELECT id FROM u2 ORDER BY id`,
    )
    expect(outcome.execution?.values).toEqual([[null], [1], [2], [3]])
    const blocks = outcome.validation?.nested ?? []
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    expect(blocks.every((block) => block.validated)).toBe(true)
  })
})

describe('UNION ALL SQLite parity', () => {
  it('preserves every branch row, including duplicates', () => {
    const outcome = parity('SELECT id, label FROM u1 UNION ALL SELECT id, label FROM u2')
    expect(outcome.execution?.values).toHaveLength(7)
    expect(outcome.validation?.method).toBe('unordered')
  })

  it('folds mixed operators left-to-right like SQLite', () => {
    const outcome = parity(
      'SELECT id FROM u1 UNION ALL SELECT id FROM u2 UNION SELECT id FROM u2 ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([[null], [1], [2], [3]])
  })
})

describe('compound validation honesty', () => {
  it('never claims parity when branches or the compound result were capped', () => {
    const sql = 'SELECT id FROM u1 UNION ALL SELECT id FROM u2'
    const outcome = simulateAndValidate(sql, [sql], db, { maxRows: 2 })
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation).not.toBeNull()
    expect(outcome.validation?.validated).toBe(false)
    expect(outcome.validation?.incomplete).toBe(true)
    const holes = outcome.validation?.nested ?? []
    expect(holes.length).toBe(2)
    expect(holes.every((block) => block.incomplete === true)).toBe(true)
    expect(holes.every((block) => block.validated === false)).toBe(true)
  })
})
