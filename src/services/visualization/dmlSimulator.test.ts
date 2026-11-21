import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'
import type { VisualizationTrace } from '../../types/visualization'

let db: SQLiteDatabase
let beforeBytes: Uint8Array

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      department_id INTEGER DEFAULT 1,
      score REAL DEFAULT 2.5,
      note TEXT DEFAULT 'new'
    );
    INSERT INTO employees (id, name, department_id, score, note) VALUES
      (1, 'Alice', 1, 10, 'a'),
      (2, 'Bob', 1, 20, 'b'),
      (3, 'Carol', 2, 30, 'c'),
      (4, 'Same', 3, 40, 'd');
    CREATE TABLE applicants (name TEXT NOT NULL, department_id INTEGER);
    INSERT INTO applicants VALUES ('Dora', 2), ('Evan', 3);
    CREATE TABLE defaults (
      id INTEGER PRIMARY KEY,
      department_id INTEGER DEFAULT 1,
      score REAL DEFAULT 2.5,
      note TEXT DEFAULT 'new'
    );
  `)
  beforeBytes = db.exportSnapshot()
})

afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

function preview(sql: string): VisualizationTrace {
  const execute = vi.spyOn(db, 'executeBatch')
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
  if (!outcome.simulation.ok) throw new Error('Expected supported preview')
  expect(outcome.validation?.validated, outcome.validation?.detail).toBe(true)
  expect(execute).not.toHaveBeenCalled()
  expect(db.exportSnapshot()).toEqual(beforeBytes)
  expect(db.queryAll('SELECT COUNT(*) FROM employees').values).toEqual([[4]])
  return outcome.simulation.trace
}

function expectFailure(sql: string, pattern: RegExp): void {
  const execute = vi.spyOn(db, 'executeBatch')
  const outcome = simulateAndValidate(sql, [sql], db)
  expect(outcome.simulation.ok).toBe(false)
  if (outcome.simulation.ok) throw new Error('Expected failed preview')
  expect(outcome.simulation.reasons.join(' ')).toMatch(pattern)
  expect(outcome.validation).toBeNull()
  expect(execute).not.toHaveBeenCalled()
  expect(db.exportSnapshot()).toEqual(beforeBytes)
}

function stage(trace: VisualizationTrace, name: VisualizationTrace['stages'][number]) {
  return trace.stageSnapshots.find((snapshot) => snapshot.stage === name)
}

describe('isolated INSERT preview', () => {
  it('previews one row with SQLite defaults and a generated id', () => {
    const trace = preview("INSERT INTO employees (name, department_id) VALUES ('Dora', 2)")
    expect(trace.dml?.affectedRowCount).toBe(1)
    expect(stage(trace, 'INSERT')?.rows.map((row) => row.values)).toEqual([[5, 'Dora', 2, 2.5, 'new']])
    expect(trace.finalRows).toHaveLength(5)
    expect(trace.dml?.columnMappings.map((mapping) => mapping.targetColumn)).toEqual(['name', 'department_id'])
  })

  it('previews multiple VALUES rows with distinct generated ids', () => {
    const trace = preview("INSERT INTO employees (name, department_id) VALUES ('Dora', 2), ('Evan', 3)")
    expect(stage(trace, 'INPUT')?.rows.map((row) => row.values)).toEqual([['Dora', 2], ['Evan', 3]])
    expect(stage(trace, 'INSERT')?.rows.map((row) => row.values[0])).toEqual([5, 6])
    expect(trace.dml?.insertedRowIds).toHaveLength(2)
  })

  it('previews INSERT SELECT using the existing SELECT simulator', () => {
    const trace = preview('INSERT INTO employees (name, department_id) SELECT name, department_id FROM applicants WHERE department_id >= 2')
    expect(stage(trace, 'INPUT')?.rows.map((row) => row.values)).toEqual([['Dora', 2], ['Evan', 3]])
    expect(stage(trace, 'INSERT')?.rows.map((row) => row.values)).toEqual([
      [5, 'Dora', 2, 2.5, 'new'], [6, 'Evan', 3, 2.5, 'new'],
    ])
  })

  it('previews DEFAULT VALUES through SQLite', () => {
    const trace = preview('INSERT INTO defaults DEFAULT VALUES')
    expect(stage(trace, 'INSERT')?.rows.map((row) => row.values)).toEqual([[1, 1, 2.5, 'new']])
  })

  it('maps an omitted column list positionally', () => {
    const trace = preview("INSERT INTO employees VALUES (5, 'Dora', 2, 8.5, 'x')")
    expect(trace.dml?.columnMappings.map((mapping) => mapping.targetColumn)).toEqual([
      'id', 'name', 'department_id', 'score', 'note',
    ])
  })

  it('reports UNIQUE and NOT NULL constraint failures without a trace', () => {
    expectFailure("INSERT INTO employees (name) VALUES ('Alice')", /UNIQUE|constraint/i)
    expectFailure('INSERT INTO employees (name) VALUES (NULL)', /NOT NULL|constraint/i)
  })
})


describe('isolated UPDATE preview', () => {
  it('distinguishes one changed row from unmatched rows', () => {
    const trace = preview('UPDATE employees SET department_id = 2 WHERE id = 1')
    expect(trace.dml?.matchedRowIds).toHaveLength(1)
    expect(trace.dml?.changedRowIds).toHaveLength(1)
    expect(stage(trace, 'MATCHED_ROWS')?.rows.map((row) => row.values[0])).toEqual([1])
    expect(stage(trace, 'CHANGED_ROWS')?.rows.map((row) => row.values)).toEqual([[1, 'Alice', 2, 10, 'a']])
    expect(trace.finalRows.map((row) => row.values[2])).toEqual([2, 1, 2, 3])
  })

  it('handles multiple matches and multiple SET assignments', () => {
    const trace = preview("UPDATE employees SET department_id = 4, note = 'Updated' WHERE department_id = 1")
    expect(trace.dml?.matchedRowIds).toHaveLength(2)
    expect(trace.dml?.changedRowIds).toHaveLength(2)
    expect(stage(trace, 'CHANGED_ROWS')?.rows.map((row) => row.values.slice(0, 3))).toEqual([
      [1, 'Alice', 4], [2, 'Bob', 4],
    ])
  })

  it('evaluates arithmetic against original row values', () => {
    const trace = preview('UPDATE employees SET department_id = department_id + 2, score = score * 2 WHERE id IN (1, 3)')
    expect(stage(trace, 'CHANGED_ROWS')?.rows.map((row) => row.values)).toEqual([
      [1, 'Alice', 3, 20, 'a'], [3, 'Carol', 4, 60, 'c'],
    ])
  })

  it('distinguishes matched-but-unchanged rows', () => {
    const trace = preview("UPDATE employees SET department_id = 1 WHERE id IN (1, 2, 3)")
    expect(trace.dml?.matchedRowIds).toHaveLength(3)
    expect(trace.dml?.changedRowIds).toHaveLength(1)
    expect(trace.dml?.unchangedRowIds).toHaveLength(2)
    expect(stage(trace, 'UNCHANGED_ROWS')?.rows.map((row) => row.values[0])).toEqual([1, 2])
    expect(stage(trace, 'CHANGED_ROWS')?.rows.map((row) => row.values[0])).toEqual([3])
  })

  it('supports zero-row updates with an honest empty classification', () => {
    const trace = preview('UPDATE employees SET department_id = 9 WHERE id = 999')
    expect(trace.dml?.affectedRowCount).toBe(0)
    expect(stage(trace, 'MATCHED_ROWS')?.rows).toEqual([])
    expect(stage(trace, 'CHANGED_ROWS')?.rows).toEqual([])
    expect(trace.finalRows).toHaveLength(4)
  })

  it('reports update constraint failures and missing columns', () => {
    expectFailure("UPDATE employees SET name = 'Alice' WHERE id = 2", /UNIQUE|constraint/i)
    expectFailure('UPDATE employees SET missing = 1 WHERE id = 1', /missing|does not exist/i)
  })
})

describe('isolated DELETE preview', () => {
  it('separates one deleted row from retained rows', () => {
    const trace = preview('DELETE FROM employees WHERE id = 2')
    expect(stage(trace, 'DELETE')?.rows.map((row) => row.values[0])).toEqual([2])
    expect(stage(trace, 'RETAINED_ROWS')?.rows.map((row) => row.values[0])).toEqual([1, 3, 4])
    expect(trace.finalRows.map((row) => row.values[0])).toEqual([1, 3, 4])
  })

  it('supports IN predicates and multiple deleted rows', () => {
    const trace = preview('DELETE FROM employees WHERE id IN (1, 2, 3)')
    expect(trace.dml?.deletedRowIds).toHaveLength(3)
    expect(trace.finalRows.map((row) => row.values[0])).toEqual([4])
  })

  it('supports no matches and DELETE without WHERE', () => {
    const none = preview('DELETE FROM employees WHERE department_id = 99')
    expect(none.dml?.affectedRowCount).toBe(0)
    expect(none.finalRows).toHaveLength(4)
    const all = preview('DELETE FROM employees')
    expect(all.dml?.affectedRowCount).toBe(4)
    expect(all.finalRows).toEqual([])
    expect(stage(all, 'RETAINED_ROWS')?.rows).toEqual([])
  })
})


describe('DML SQLite semantics and failures', () => {
  it('enforces foreign keys on the isolated connection', () => {
    db.runRaw('CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))')
    beforeBytes = db.exportSnapshot()
    expectFailure('INSERT INTO children (id, parent_id) VALUES (1, 999)', /FOREIGN KEY|constraint/i)
  })

  it('preserves NOCASE collation and NUMERIC affinity in WHERE matching', () => {
    db.runRaw("CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT COLLATE NOCASE, amount NUMERIC); INSERT INTO words VALUES (1, 'Alice', '1'), (2, 'Bob', '2')")
    beforeBytes = db.exportSnapshot()
    const trace = preview("UPDATE words SET amount = amount + 1 WHERE word = 'alice' AND amount = 1")
    expect(trace.dml?.matchedRowIds).toHaveLength(1)
    expect(stage(trace, 'CHANGED_ROWS')?.rows.map((row) => row.values)).toEqual([[1, 'Alice', 2]])
  })

  it('evaluates every SET expression against the original row', () => {
    const trace = preview('UPDATE employees SET department_id = score, score = department_id WHERE id = 1')
    expect(stage(trace, 'CHANGED_ROWS')?.rows.map((row) => row.values)).toEqual([[1, 'Alice', 10, 1, 'a']])
  })

  it('rejects missing tables, rowid changes, generated columns, and trigger-like side effects honestly', () => {
    expectFailure("UPDATE missing SET value = 1", /does not exist/i)
    expectFailure('UPDATE employees SET id = 8 WHERE id = 1', /rowid|PRIMARY KEY/i)
    db.runRaw('CREATE TABLE generated_values (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL)')
    beforeBytes = db.exportSnapshot()
    expectFailure('INSERT INTO generated_values (a) VALUES (2)', /generated columns/i)
  })
})
