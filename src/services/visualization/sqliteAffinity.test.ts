import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { readTableFromDb } from './validation'
import {
  applyNumericAffinity,
  applyTextAffinity,
  asciiLowerCase,
  compareValues,
  deriveAffinity,
  isWellFormedNumericText,
  normalizeCollation,
  numberToSqliteText,
} from './sqliteAffinity'

describe('SQLite declared-type affinity', () => {
  it.each([
    ['INT', 'INTEGER'],
    ['CHARINT', 'INTEGER'],
    ['VARCHAR(255)', 'TEXT'],
    ['CLOB', 'TEXT'],
    ['BLOB', 'BLOB'],
    ['', 'BLOB'],
    ['DOUBLE PRECISION', 'REAL'],
    ['FLOAT', 'REAL'],
    ['DECIMAL(10, 2)', 'NUMERIC'],
    ['BOOLEAN', 'NUMERIC'],
  ] as const)('derives %s as %s', (declaredType, expected) => {
    expect(deriveAffinity(declaredType)).toBe(expected)
  })

  it('normalizes only the supported core collations', () => {
    expect(normalizeCollation(' binary ')).toBe('BINARY')
    expect(normalizeCollation('nocase')).toBe('NOCASE')
    expect(normalizeCollation('RTRIM')).toBeNull()
  })
})

describe('SQLite comparison value helpers', () => {
  it('converts only well-formed numeric text for NUMERIC affinity', () => {
    expect(applyNumericAffinity('  -12.5e2  ')).toBe(-1250)
    expect(applyNumericAffinity('12abc')).toBe('12abc')
    expect(applyNumericAffinity('')).toBe('')
    expect(isWellFormedNumericText('.5')).toBe(true)
    expect(isWellFormedNumericText('1e')).toBe(false)
  })

  it('preserves integer and real spelling under TEXT affinity', () => {
    expect(numberToSqliteText(10, 'integer')).toBe('10')
    expect(numberToSqliteText(10, 'real')).toBe('10.0')
    expect(numberToSqliteText(1e20, 'real')).toBe('1.0e+20')
    expect(applyTextAffinity(10, 'real')).toBe('10.0')
  })

  it('uses storage-class order, ASCII NOCASE, and bytewise BLOB order', () => {
    expect(compareValues(10, '2')).toBeLessThan(0)
    expect(compareValues('2', new Uint8Array([1]))).toBeLessThan(0)
    expect(compareValues('Alpha', 'alpha', 'BINARY')).toBeLessThan(0)
    expect(compareValues('Alpha', 'alpha', 'NOCASE')).toBe(0)
    expect(asciiLowerCase('ÄZ')).toBe('Äz')
    expect(compareValues(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBeLessThan(0)
  })
})

describe('live table comparison metadata', () => {
  let db: SQLiteDatabase

  beforeEach(async () => {
    db = await SQLiteDatabase.create()
    db.runRaw(`
      CREATE TABLE affinity_samples (
        id INTEGER PRIMARY KEY,
        ci TEXT COLLATE NOCASE,
        trimmed VARCHAR(20) COLLATE RTRIM,
        amount DECIMAL(10, 2),
        payload BLOB,
        untyped
      );
      INSERT INTO affinity_samples VALUES (1, 'Alpha', 'x', '12.50', X'0102', 10);
    `)
  })

  afterEach(() => db.close())

  it('derives affinity and declared collation from the actual SQLite schema', () => {
    const table = readTableFromDb(db, 'affinity_samples')
    expect(table).not.toBeNull()
    expect(table?.columnMeta).toEqual([
      { affinity: 'INTEGER', collation: 'BINARY' },
      { affinity: 'TEXT', collation: 'NOCASE' },
      { affinity: 'TEXT', collation: 'BINARY', unsupportedCollation: 'RTRIM' },
      { affinity: 'NUMERIC', collation: 'BINARY' },
      { affinity: 'BLOB', collation: 'BINARY' },
      { affinity: 'BLOB', collation: 'BINARY' },
    ])
    expect(table?.rows).toEqual([[1, 'Alpha', 'x', 12.5, new Uint8Array([1, 2]), 10]])
  })
})
