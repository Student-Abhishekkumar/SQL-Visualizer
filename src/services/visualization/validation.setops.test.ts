import { beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'

let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE s1 (id INTEGER, label TEXT);
    CREATE TABLE s2 (id INTEGER, label TEXT);
    CREATE TABLE s3 (id INTEGER, label TEXT);
    CREATE TABLE empty (id INTEGER, label TEXT);
    CREATE TABLE one (n INTEGER);
    CREATE TABLE two (n INTEGER);

    INSERT INTO s1 (id, label) VALUES
      (1, 'a'), (2, 'b'), (NULL, 'n'), (2, 'b'), (3, 'c'), (4, 'd');
    INSERT INTO s2 (id, label) VALUES
      (2, 'b'), (NULL, 'n'), (4, 'd'), (2, 'b'), (5, 'e');
    INSERT INTO s3 (id, label) VALUES
      (2, 'b'), (3, 'c'), (5, 'e'), (1, 'different');
    INSERT INTO one (n) VALUES (1);
    INSERT INTO two (n) VALUES (2);
  `)
})

function parity(sql: string) {
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, JSON.stringify(outcome.simulation)).toBe(true)
  expect(outcome.execution).not.toBeNull()
  expect(outcome.validation?.validated, outcome.validation?.detail).toBe(true)
  return outcome
}

describe('INTERSECT / EXCEPT SQLite parity', () => {
  it('matches INTERSECT with duplicates and NULLs, including branch parity', () => {
    const outcome = parity(
      'SELECT id, label FROM s1 INTERSECT SELECT id, label FROM s2 ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([
      [null, 'n'],
      [2, 'b'],
      [4, 'd'],
    ])
    expect(outcome.validation?.nested).toHaveLength(2)
    expect(outcome.validation?.nested?.every((block) => block.validated)).toBe(true)
  })

  it('matches EXCEPT with duplicates and NULLs', () => {
    const outcome = parity(
      'SELECT id, label FROM s1 EXCEPT SELECT id, label FROM s2 ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([
      [1, 'a'],
      [3, 'c'],
    ])
  })

  it('matches mixed UNION / INTERSECT chains without precedence rewriting', () => {
    expect(
      parity('SELECT n FROM one UNION SELECT n FROM two INTERSECT SELECT n FROM two').execution
        ?.values,
    ).toEqual([[2]])
    expect(
      parity('SELECT n FROM one UNION ALL SELECT n FROM one INTERSECT SELECT n FROM one').execution
        ?.values,
    ).toEqual([[1]])
  })

  it('matches EXCEPT followed by UNION across multiple columns', () => {
    const outcome = parity(
      'SELECT id, label FROM s1 EXCEPT SELECT id, label FROM s2 UNION SELECT id, label FROM s3 ORDER BY id, label',
    )
    expect(outcome.execution?.values).toEqual([
      [1, 'a'],
      [1, 'different'],
      [2, 'b'],
      [3, 'c'],
      [5, 'e'],
    ])
  })

  it('matches a longer left-to-right mixed chain', () => {
    const outcome = parity(`SELECT id, label FROM s1
      UNION ALL SELECT id, label FROM s2
      INTERSECT SELECT id, label FROM s2
      EXCEPT SELECT id, label FROM s3
      UNION ALL SELECT n, 'one' FROM one`)
    expect(outcome.execution?.values).toEqual([
      [null, 'n'],
      [4, 'd'],
      [1, 'one'],
    ])
  })

  it('compares complete rows rather than matching individual columns', () => {
    const outcome = parity(
      'SELECT id, label FROM s1 INTERSECT SELECT id, label FROM s3 ORDER BY id',
    )
    expect(outcome.execution?.values).toEqual([
      [2, 'b'],
      [3, 'c'],
    ])
  })

  it('applies ORDER BY after the set operation', () => {
    const outcome = parity(
      'SELECT id, label FROM s1 INTERSECT SELECT id, label FROM s2 ORDER BY id DESC',
    )
    expect(outcome.execution?.values).toEqual([
      [4, 'd'],
      [2, 'b'],
      [null, 'n'],
    ])
    expect(outcome.validation?.method).toBe('ordered')
  })

  it('applies LIMIT/OFFSET to the compound result', () => {
    const outcome = parity(
      'SELECT id, label FROM s1 EXCEPT SELECT id, label FROM s2 ORDER BY id LIMIT 1 OFFSET 1',
    )
    expect(outcome.execution?.values).toEqual([[3, 'c']])
  })

  it('validates empty results', () => {
    const outcome = parity('SELECT id FROM s1 EXCEPT SELECT id FROM s1')
    expect(outcome.execution?.values).toEqual([])
    expect(outcome.simulation.ok && outcome.simulation.trace.finalRows).toEqual([])
  })

  it('preserves first-branch column names', () => {
    const outcome = parity(
      'SELECT id AS first_id, label AS first_label FROM s1 INTERSECT SELECT id AS second_id, label AS second_label FROM s2 ORDER BY first_id',
    )
    expect(outcome.execution?.columns).toEqual(['first_id', 'first_label'])
    expect(outcome.simulation.ok && outcome.simulation.trace.finalColumns).toEqual([
      'first_id',
      'first_label',
    ])
  })
})

describe('set-operation validation honesty', () => {
  it.each(['INTERSECT', 'EXCEPT'] as const)(
    'suppresses parity for incomplete %s branches',
    (operator) => {
      const sql = `SELECT id, label FROM s1 ${operator} SELECT id, label FROM s2`
      const outcome = simulateAndValidate(sql, [sql], db, { maxRows: 2 })
      expect(outcome.simulation.ok).toBe(true)
      expect(outcome.simulation.ok && outcome.simulation.trace.incomplete).toBe(true)
      expect(outcome.validation?.validated).toBe(false)
      expect(outcome.validation?.incomplete).toBe(true)
      expect(outcome.validation?.nested?.every((block) => block.validated === false)).toBe(true)
    },
  )

  it('suppresses parity when the folded compound result is capped', () => {
    const sql = 'SELECT id, label FROM s1 UNION ALL SELECT id, label FROM s2 EXCEPT SELECT id, label FROM empty'
    const outcome = simulateAndValidate(sql, [sql], db, { maxRows: 2 })
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.simulation.ok && outcome.simulation.trace.truncated).toBe(true)
    expect(outcome.simulation.ok && outcome.simulation.trace.incomplete).toBe(true)
    expect(outcome.validation?.validated).toBe(false)
    expect(outcome.validation?.incomplete).toBe(true)
  })
})
