import { beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'

/**
 * SQLite parity for IN / NOT IN / EXISTS / NOT EXISTS.
 *
 * A dedicated database gives every NULL case real data: `t` has a NULL
 * value and `s` (the subquery source) has a NULL member, so three-valued
 * logic is compared against SQLite rather than hand-computed.
 */

let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE t (id INTEGER, v INTEGER);
    CREATE TABLE s (id INTEGER);
    INSERT INTO t (id, v) VALUES (1, 1), (2, 2), (3, NULL);
    INSERT INTO s (id) VALUES (1), (NULL);
  `)
})

/** Simulate + execute, insisting both succeeded and parity was claimed. */
function parity(sql: string) {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, JSON.stringify(outcome.simulation)).toBe(true)
  expect(outcome.execution).not.toBeNull()
  expect(outcome.validation?.validated).toBe(true)
  return outcome
}

describe('IN / NOT IN SQLite parity', () => {
  it('matches on a real value and leaves NULL / no-match rows out', () => {
    const outcome = parity('SELECT id FROM t WHERE v IN (SELECT id FROM s) ORDER BY id')
    expect(outcome.execution?.values).toEqual([[1]])
  })

  it('respects NULL in the subquery for NOT IN', () => {
    const outcome = parity('SELECT id FROM t WHERE v NOT IN (SELECT id FROM s) ORDER BY id')
    // v=1 matches; v=2 has no match but the list contains NULL (UNKNOWN);
    // v=NULL is UNKNOWN. Every row is filtered out.
    expect(outcome.execution?.values).toEqual([])
  })

  it('handles NOT IN with matching and non-matching values', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE v NOT IN (SELECT id FROM s WHERE id = 1) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([[2]])
  })

  it('treats an empty subquery as false for IN', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE v IN (SELECT id FROM s WHERE id > 100) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([])
  })

  it('treats an empty subquery as true for NOT IN, even for NULL', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE v NOT IN (SELECT id FROM s WHERE id > 100) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([[1], [2], [3]])
  })

  it('validates the IN block itself against SQLite', () => {
    const outcome = parity('SELECT id FROM t WHERE v IN (SELECT id FROM s) ORDER BY id')
    const blocks = outcome.validation?.nested ?? []
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((block) => block.validated)).toBe(true)
    expect(blocks[0]?.blockId).toBe('q2')
  })
})

describe('EXISTS / NOT EXISTS SQLite parity', () => {
  it('keeps rows when the subquery has rows', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM s WHERE id = 1) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([[1], [2], [3]])
  })

  it('drops rows when the subquery is empty', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM s WHERE id > 100) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([])
  })

  it('inverts with NOT EXISTS', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE NOT EXISTS (SELECT 1 FROM s WHERE id > 100) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([[1], [2], [3]])
  })

  it('ignores the column count of an EXISTS subquery', () => {
    const outcome = parity(
      'SELECT id FROM t WHERE EXISTS (SELECT id, id FROM s WHERE id = 1) ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([[1], [2], [3]])
  })
})

describe('subquery blocks alongside CTEs and scalar subqueries', () => {
  it('reads a CTE from an IN subquery and validates both blocks', () => {
    const outcome = parity(
      `WITH c AS (SELECT id FROM s WHERE id = 1)
       SELECT id FROM t WHERE v IN (SELECT id FROM c) ORDER BY id`,
    )
    expect(outcome.execution?.values).toEqual([[1]])
    const blocks = outcome.validation?.nested ?? []
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    expect(blocks.every((block) => block.validated)).toBe(true)
  })

  it('keeps scalar subqueries over CTEs working', () => {
    const outcome = parity(
      `WITH c AS (SELECT MIN(id) AS m FROM s)
       SELECT id FROM t WHERE v = (SELECT m FROM c) ORDER BY id`,
    )
    expect(outcome.execution?.values).toEqual([[1]])
  })

  it('handles multiple blocks in one predicate', () => {
    const outcome = parity(
      `SELECT id FROM t
       WHERE v IN (SELECT id FROM s WHERE id = 1)
         AND EXISTS (SELECT 1 FROM s)`,
    )
    expect(outcome.execution?.values).toEqual([[1]])
  })
})

describe('unsupported subquery forms are reported, never faked', () => {
  it('rejects multi-column IN subqueries', () => {
    const sql = 'SELECT id FROM t WHERE v IN (SELECT id, id FROM s)'
    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) return
    expect(outcome.simulation.reasons.join(' ')).toMatch(/requires exactly one/i)
  })

  it('rejects correlated subqueries instead of guessing', () => {
    const sql = `SELECT id FROM t
      WHERE EXISTS (SELECT 1 FROM s WHERE s.id = t.id)`
    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) return
    expect(outcome.simulation.reasons.join(' ')).toMatch(/correlated/i)
  })
})