import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { analyzeCapability } from './capabilityAnalyzer'
import { interpretQuery } from './astInterpreter'
import { simulateAndValidate } from './validation'

/** Every expectation in this file is checked against real sql.js execution. */
let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE affinity_samples (
      id INTEGER PRIMARY KEY,
      i INTEGER,
      t TEXT,
      n NUMERIC,
      r REAL,
      u,
      ci TEXT COLLATE NOCASE,
      cb TEXT COLLATE BINARY
    );
    INSERT INTO affinity_samples VALUES
      (1, 10, 10, 10, 10.0, 10, 'Alpha', 'Alpha'),
      (2, '20', '20', '20', '20', '20', 'beta', 'beta'),
      (3, '12abc', '12abc', '12abc', '12abc', '12abc', 'ALPHA', 'ALPHA'),
      (4, NULL, NULL, NULL, NULL, NULL, 'Ä', 'Ä'),
      (5, '10x', '10x', '10x', '10x', '10x', 'alpha', 'alpha');

    CREATE TABLE words (
      id INTEGER PRIMARY KEY,
      ci TEXT COLLATE NOCASE,
      cb TEXT COLLATE BINARY
    );
    INSERT INTO words VALUES
      (1, 'Alpha', 'Alpha'),
      (2, 'alpha', 'alpha'),
      (3, 'Beta', 'Beta'),
      (4, 'Ä', 'Ä'),
      (5, 'ä', 'ä'),
      (6, NULL, NULL),
      (7, 'ALPHA', 'ALPHA'),
      (8, 'beta', 'beta');

    CREATE TABLE trimmed_words (
      id INTEGER PRIMARY KEY,
      v TEXT COLLATE RTRIM
    );
    INSERT INTO trimmed_words VALUES
      (1, 'Alpha  '),
      (2, 'Alpha'),
      (3, 'Beta');
  `)
})

afterEach(() => db.close())

function expectParity(sql: string): void {
  const capability = analyzeCapability(interpretQuery(sql, [sql]))
  expect(capability.supported, `${sql}: ${capability.unsupportedReason ?? ''}`).toBe(true)
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(
    outcome.simulation.ok,
    outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; '),
  ).toBe(true)
  if (!outcome.simulation.ok) return
  expect(outcome.execution, `SQLite execution missing for ${sql}`).not.toBeNull()
  expect(outcome.validation?.validated, outcome.validation?.detail).toBe(true)
  expect(outcome.simulation.trace.finalColumns).toEqual(outcome.execution?.columns)
  if (outcome.simulation.trace.hasDeterministicOrder) {
    expect(outcome.simulation.trace.finalRows.map((row) => row.values)).toEqual(
      outcome.execution?.values,
    )
  }
}

const AFFINITY_CASES = [
  "SELECT id FROM affinity_samples WHERE i = '10' ORDER BY id",
  'SELECT id FROM affinity_samples WHERE t = 10 ORDER BY id',
  'SELECT id FROM affinity_samples WHERE t = 10.0 ORDER BY id',
  'SELECT id FROM affinity_samples WHERE t = 1e1 ORDER BY id',
  "SELECT id FROM affinity_samples WHERE n = '0010.0' ORDER BY id",
  "SELECT id FROM affinity_samples WHERE u = '10' ORDER BY id",
  'SELECT id FROM affinity_samples WHERE u = 10 ORDER BY id',
  'SELECT id FROM affinity_samples WHERE i = t ORDER BY id',
  'SELECT id FROM affinity_samples WHERE i = n ORDER BY id',
  'SELECT id FROM affinity_samples WHERE t = u ORDER BY id',
  'SELECT id FROM affinity_samples WHERE i = 5 + 5 ORDER BY id',
  'SELECT id FROM affinity_samples WHERE t = 5 + 5 ORDER BY id',
  "SELECT id FROM affinity_samples WHERE i IN ('10', '12abc', NULL) ORDER BY id",
  "SELECT id FROM affinity_samples WHERE i BETWEEN '9' AND '11' ORDER BY id",
  'SELECT id FROM affinity_samples WHERE i = NULL ORDER BY id',
  'SELECT id FROM affinity_samples WHERE i IS NULL ORDER BY id',
  "SELECT id FROM affinity_samples WHERE u < '0' ORDER BY id",
]

describe('SQLite affinity comparison parity', () => {
  it.each(AFFINITY_CASES)('%s', expectParity)

  it('propagates scalar-subquery affinity to a literal comparison', () => {
    expectParity(`SELECT id FROM affinity_samples
      WHERE '10' = (SELECT i FROM affinity_samples WHERE id = 1) ORDER BY id`)
  })

  it('propagates subquery affinity and collation through IN', () => {
    expectParity(`SELECT id FROM words
      WHERE 'aLpHa' IN (SELECT ci FROM words) ORDER BY id`)
  })
})

const COLLATION_CASES = [
  "SELECT id FROM words WHERE ci = 'ALPHA' ORDER BY id",
  "SELECT id FROM words WHERE cb = 'ALPHA' ORDER BY id",
  "SELECT cb AS v FROM words WHERE v COLLATE NOCASE = 'ALPHA' ORDER BY id",
  "SELECT id FROM words WHERE cb COLLATE NOCASE = 'ALPHA' ORDER BY id",
  "SELECT id FROM words WHERE ci COLLATE BINARY = 'ALPHA' ORDER BY id",
  "SELECT id FROM words WHERE ci COLLATE BINARY = 'alpha' COLLATE NOCASE ORDER BY id",
  "SELECT id FROM words WHERE ci = 'alpha' COLLATE NOCASE ORDER BY id",
  'SELECT ci, COUNT(*) AS c FROM words GROUP BY ci ORDER BY c, ci',
  'SELECT cb, COUNT(*) AS c FROM words GROUP BY cb ORDER BY cb',
  'SELECT ci, COUNT(*) AS c FROM words GROUP BY cb COLLATE NOCASE ORDER BY c, ci',
  'SELECT cb AS v, COUNT(*) AS c FROM words GROUP BY v COLLATE NOCASE ORDER BY c, v',
  'SELECT DISTINCT ci FROM words',
  'SELECT DISTINCT cb FROM words',
  'SELECT id, cb FROM words ORDER BY cb COLLATE NOCASE, id',
  'WITH x AS (SELECT ci AS v FROM words) SELECT DISTINCT v FROM x',
  "SELECT ci AS v FROM words WHERE id = 1 UNION SELECT 'ALPHA' FROM words WHERE id = 7",
  "SELECT cb AS v FROM words WHERE id = 1 UNION SELECT 'ALPHA' FROM words WHERE id = 7",
  "SELECT ci AS v FROM words WHERE id = 1 INTERSECT SELECT 'ALPHA' FROM words WHERE id = 7",
  "SELECT cb AS v FROM words WHERE id = 1 INTERSECT SELECT 'ALPHA' FROM words WHERE id = 7",
  "SELECT ci AS v FROM words WHERE id <= 2 UNION SELECT 'BETA' FROM words WHERE id = 3 ORDER BY v COLLATE NOCASE",
  'SELECT ci AS v FROM words WHERE id = 7 UNION SELECT ci FROM words WHERE id <= 2',
  'SELECT ci AS v FROM words WHERE id <= 2 UNION SELECT ci FROM words WHERE 0',
  'SELECT ci AS v FROM words WHERE id IN (1, 7) UNION SELECT ci FROM words WHERE id = 2',
]

describe('SQLite BINARY and NOCASE parity', () => {
  it.each(COLLATION_CASES)('%s', expectParity)

  it('keeps NOCASE folding ASCII-only', () => {
    expectParity("SELECT id FROM words WHERE ci = 'ä' ORDER BY id")
    expectParity("SELECT id FROM words WHERE ci = 'Ä' ORDER BY id")
  })

  it('applies declared and explicit collation to aggregate DISTINCT, MIN and MAX', () => {
    expectParity('SELECT COUNT(DISTINCT ci) AS c FROM words')
    expectParity('SELECT COUNT(DISTINCT ci COLLATE BINARY) AS c FROM words')
    expectParity('SELECT COUNT(DISTINCT cb COLLATE NOCASE) AS c FROM words')
    expectParity('SELECT MAX(ci) AS v FROM words WHERE id IN (1, 2)')
    expectParity('SELECT MAX(cb COLLATE NOCASE) AS v FROM words WHERE id IN (1, 2)')
    expectParity('SELECT MAX(ci) AS v FROM words WHERE id <= 3')
  })
})

describe('unsupported declared collation safety', () => {
  it.each([
    "SELECT id FROM trimmed_words WHERE v = 'Alpha'",
    'SELECT DISTINCT v FROM trimmed_words',
    'SELECT v, COUNT(*) FROM trimmed_words GROUP BY v',
    'SELECT id FROM trimmed_words ORDER BY v',
    'SELECT MAX(v) FROM trimmed_words',
    'SELECT v FROM trimmed_words UNION SELECT v FROM trimmed_words WHERE id = 1',
  ])('rejects rather than silently using BINARY: %s', (sql) => {
    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) return
    expect(outcome.simulation.reasons.join(' ')).toMatch(/RTRIM|BINARY and NOCASE/)
    expect(outcome.execution).toBeNull()
    expect(outcome.validation).toBeNull()
  })

  it('allows an explicit supported collation to override the declaration', () => {
    expectParity('SELECT DISTINCT v COLLATE BINARY AS v FROM trimmed_words')
    expectParity('SELECT id FROM trimmed_words ORDER BY v COLLATE BINARY, id')
    expectParity('SELECT v FROM trimmed_words UNION ALL SELECT v FROM trimmed_words WHERE id = 1')
  })

  it('rejects unsupported explicit collations during capability analysis', () => {
    const sql = "SELECT id FROM words WHERE ci COLLATE RTRIM = 'Alpha'"
    const capability = analyzeCapability(interpretQuery(sql, [sql]))
    expect(capability.supported).toBe(false)
    expect(capability.unsupportedReason).toMatch(/RTRIM/)
    const outcome = simulateAndValidate(sql, [sql], db)
    expect(outcome.simulation.ok).toBe(false)
    expect(outcome.execution).toBeNull()
  })

})
