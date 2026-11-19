import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { compareSimulationWithSqlite } from './validation'
import { rowKey, rowsMatchUnordered, valuesEqual } from './rowIdentity'
import { simulateAndValidate } from './validation'

function trace(values: unknown[][], columns = ['a']) {
  return {
    finalColumns: columns,
    finalRows: values.map((row, index) => ({ id: `r${index}`, values: row })),
    hasDeterministicOrder: false,
  }
}

describe('collision-safe row identity', () => {
  it('separates the exact delimiter collision example', () => {
    expect(rowKey(['a|string:b'])).not.toBe(rowKey(['a', 'b']))
    expect(rowKey(['a|string:b', 'c'])).not.toBe(rowKey(['a', 'b|string:c']))
  })

  it('distinguishes column boundaries, counts, empty strings and NULL', () => {
    expect(rowKey(['a', 'b'])).not.toBe(rowKey(['a,b']))
    expect(rowKey([1])).not.toBe(rowKey([1, 2]))
    expect(rowKey([''])).not.toBe(rowKey([null]))
    expect(rowKey([])).not.toBe(rowKey([null]))
    expect(rowKey([undefined])).toBe(rowKey([null]))
  })

  it('handles Unicode and delimiter characters deterministically', () => {
    expect(rowKey(['🌸', '💩'])).not.toBe(rowKey(['🌸💩']))
    expect(rowKey(['🌸', '💩'])).toBe(rowKey(['🌸', '💩']))
    expect(rowKey(['a|b', 'c'])).not.toBe(rowKey(['a', 'b|c']))
  })

  it('distinguishes numbers from numeric-looking strings and other types', () => {
    expect(rowKey([1])).not.toBe(rowKey(['1']))
    expect(rowKey([1n])).not.toBe(rowKey([1]))
    expect(rowKey([true])).not.toBe(rowKey([1]))
    expect(valuesEqual(1, '1')).toBe(false)
    expect(valuesEqual(1n, 1)).toBe(false)
    expect(valuesEqual(true, 1)).toBe(false)
    expect(valuesEqual(1, 1.0)).toBe(true)
    expect(valuesEqual(-0, 0)).toBe(true)
  })

  it('handles negative numbers, floating point values, infinities and NaN', () => {
    expect(rowKey([-0])).toBe(rowKey([0]))
    expect(rowKey([-1.25])).toBe(rowKey([-1.25]))
    expect(valuesEqual(Number.NaN, Number.NaN)).toBe(true)
    expect(valuesEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(true)
    expect(valuesEqual(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe(true)
    expect(valuesEqual(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe(false)
    expect(valuesEqual(1.0000000001, 1.0000000002)).toBe(true)
    expect(valuesEqual(1, 1.1)).toBe(false)
  })

  it('compares blobs by their bytes rather than object or string identity', () => {
    expect(rowKey([new Uint8Array([1, 2, 255])])).toBe(rowKey([new Uint8Array([1, 2, 255])]))
    expect(rowKey([new Uint8Array([1, 2, 255])])).not.toBe(rowKey([new Uint8Array([1, 2, 254])]))
    expect(rowKey([new Uint8Array([1, 2])])).not.toBe(rowKey(['1,2']))
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
  })

  it('rejects unsupported object values instead of stringifying them', () => {
    expect(() => rowKey([{ value: 1 }])).toThrow(TypeError)
  })

  it('preserves duplicate rows and rejects different multiset contents', () => {
    expect(rowsMatchUnordered([[1], [1]], [[1], [1]])).toBe(true)
    expect(rowsMatchUnordered([[1], [1]], [[1], [2]])).toBe(false)
    expect(rowsMatchUnordered([[1]], [[1], [1]])).toBe(false)
    expect(rowsMatchUnordered([[1, 2]], [[1]])).toBe(false)
  })
})

describe('ordered and unordered validation consistency', () => {
  it('rejects numeric values versus numeric-looking strings in both methods', () => {
    for (const hasDeterministicOrder of [false, true]) {
      const result = compareSimulationWithSqlite(
        { ...trace([[1]]), hasDeterministicOrder },
        { columns: ['a'], values: [['1']] },
      )
      expect(result.validated).toBe(false)
    }
  })

  it('uses the same floating-point tolerance in both methods', () => {
    for (const hasDeterministicOrder of [false, true]) {
      const result = compareSimulationWithSqlite(
        { ...trace([[51333.33333333]]), hasDeterministicOrder },
        { columns: ['a'], values: [[51333.33333332]] },
      )
      expect(result.validated).toBe(true)
    }
  })

  it('does not confuse delimiter-containing rows in either method', () => {
    for (const hasDeterministicOrder of [false, true]) {
      const result = compareSimulationWithSqlite(
        { ...trace([['a|string:b', 'c']], ['a', 'b']), hasDeterministicOrder },
        { columns: ['a', 'b'], values: [['a', 'b|string:c']] },
      )
      expect(result.validated).toBe(false)
    }
  })

  it('checks column counts before comparing rows', () => {
    const result = compareSimulationWithSqlite(trace([[1, 2]], ['a', 'b']), {
      columns: ['a'],
      values: [[1, 2]],
    })
    expect(result.validated).toBe(false)
  })
})

describe('SQLite row-identity regressions', () => {
  let db: SQLiteDatabase

  beforeEach(async () => {
    db = await SQLiteDatabase.create()
    db.runRaw(`
      CREATE TABLE t (a TEXT, b TEXT);
      INSERT INTO t (a, b) VALUES
        ('a|string:b', 'c'),
        ('a', 'b|string:c');
    `)
  })

  afterEach(() => db.close())

  function parity(sql: string) {
    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok, JSON.stringify(outcome.simulation)).toBe(true)
    expect(outcome.validation?.validated, outcome.validation?.detail).toBe(true)
    return outcome
  }

  it('keeps DISTINCT rows separate and validates them', () => {
    const outcome = parity('SELECT DISTINCT a, b FROM t')
    expect(outcome.execution?.values).toHaveLength(2)
  })

  it('keeps GROUP BY groups separate and validates them', () => {
    const outcome = parity('SELECT a, b, COUNT(*) AS n FROM t GROUP BY a, b ORDER BY a, b')
    expect(outcome.execution?.values).toHaveLength(2)
  })

  it('keeps UNION rows separate and validates them', () => {
    const outcome = parity('SELECT a, b FROM t UNION SELECT a, b FROM t')
    expect(outcome.execution?.values).toHaveLength(2)
  })

  it('keeps INTERSECT rows separate and validates them', () => {
    const outcome = parity('SELECT a, b FROM t INTERSECT SELECT a, b FROM t')
    expect(outcome.execution?.values).toHaveLength(2)
  })

  it('keeps EXCEPT rows separate and validates them', () => {
    const outcome = parity('SELECT a, b FROM t EXCEPT SELECT a, b FROM t')
    expect(outcome.execution?.values).toEqual([])
  })
})
