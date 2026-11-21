import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import { simulateAndValidate } from './validation'
import { splitStatements } from '../../utils/queryHelpers'
import {
  createDatabase,
  getLiveDatabase,
  resetDatabaseManagerForTests,
} from '../database/databaseManager'
import { clearAllDatabaseData } from '../persistence/persistenceService'
import { useDatabaseStore } from '../../store/databaseStore'

let db: SQLiteDatabase

beforeEach(async () => {
  db = await SQLiteDatabase.create()
  db.runRaw(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO items (id, label) VALUES (1, 'one'), (2, 'two');
  `)
  resetDatabaseManagerForTests()
  useDatabaseStore.setState({
    status: 'uninitialized',
    initError: null,
    schema: null,
    activeDatabaseId: null,
    databases: [],
    isExecuting: false,
    lastResult: null,
  })
  await clearAllDatabaseData({ includeHistory: true, includeSavedQueries: true })
})

afterEach(() => {
  db.close()
  resetDatabaseManagerForTests()
  vi.restoreAllMocks()
})

function rows() {
  return db.queryAll('SELECT id, label FROM items ORDER BY id').values
}

function schema() {
  return db.queryAll('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').values
}

function expectRejected(sql: string) {
  const executeSpy = vi.spyOn(db, 'executeBatch')
  const beforeRows = rows()
  const beforeSchema = schema()
  const outcome = simulateAndValidate(sql, splitStatements(sql), db)

  expect(outcome.simulation.ok).toBe(false)
  expect(outcome.execution).toBeNull()
  expect(outcome.validation).toBeNull()
  expect(executeSpy).not.toHaveBeenCalled()
  expect(rows()).toEqual(beforeRows)
  expect(schema()).toEqual(beforeSchema)
  if (outcome.simulation.ok) throw new Error('Expected visualization to be rejected')
  expect(outcome.simulation.reasons.length).toBeGreaterThan(0)
}

describe('Visualize read-only enforcement', () => {
  it.each([
    ['REPLACE', "REPLACE INTO items (id, label) VALUES (1, 'replacement')"],
    ['CREATE VIEW', 'CREATE VIEW item_view AS SELECT * FROM items'],
    ['SELECT followed by DELETE', 'SELECT 1; DELETE FROM items'],
    ['multiple SELECT statements', 'SELECT 1; SELECT 2'],
    ['multiple DML statements', "INSERT INTO items (id, label) VALUES (3, 'three'); DELETE FROM items"],
    ['CTE followed by mutation', 'WITH x AS (SELECT 1) SELECT * FROM x; DELETE FROM items'],
    ['mutating CTE statement', 'WITH x AS (SELECT 1) DELETE FROM items'],
    ['empty input', ''],
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['ATTACH', "ATTACH DATABASE ':memory:' AS other"],
    ['DETACH', 'DETACH DATABASE other'],
    ['PRAGMA', 'PRAGMA user_version = 1'],
    ['unsupported SELECT expression', 'SELECT ABS(id) FROM items'],
    ['missing source table', 'SELECT * FROM missing_table'],
  ])('rejects %s without executing or mutating', (_name, sql) => {
    expectRejected(sql)
  })

  it.each([
    ['INSERT', "INSERT INTO items (id, label) VALUES (3, 'three')"],
    ['UPDATE', "UPDATE items SET label = 'changed' WHERE id = 1"],
    ['DELETE', 'DELETE FROM items'],
    ['comment-prefixed DELETE', '-- leading comment\nDELETE FROM items'],
    ['CREATE TABLE', 'CREATE TABLE other (id INTEGER)'],
    ['ALTER TABLE', 'ALTER TABLE items ADD COLUMN extra TEXT'],
    ['DROP TABLE', 'DROP TABLE items'],
    ['CREATE INDEX', 'CREATE INDEX items_label ON items(label)'],
    ['DROP INDEX', 'DROP INDEX IF EXISTS missing_index'],
  ])('previews %s on an isolated copy without mutating the active database', (_name, sql) => {
    const executeSpy = vi.spyOn(db, 'executeBatch')
    const beforeRows = rows()
    const beforeSchema = schema()
    const outcome = simulateAndValidate(sql, splitStatements(sql), db)

    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.execution).toBeNull()
    expect(outcome.validation?.validated).toBe(true)
    // The active connection's executor is never used for the preview.
    expect(executeSpy).not.toHaveBeenCalled()
    expect(rows()).toEqual(beforeRows)
    expect(schema()).toEqual(beforeSchema)
  })

  it('rejects DML on a table with a trigger before executing it', () => {
    db.runRaw(`
      CREATE TABLE audit (note TEXT);
      CREATE TRIGGER items_audit AFTER INSERT ON items BEGIN
        INSERT INTO audit (note) VALUES ('inserted');
      END;
    `)
    const executeSpy = vi.spyOn(db, 'executeBatch')
    const beforeRows = rows()
    const outcome = simulateAndValidate(
      "INSERT INTO items (id, label) VALUES (3, 'three')",
      ["INSERT INTO items (id, label) VALUES (3, 'three')"],
      db,
    )

    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) throw new Error('Expected trigger-backed DML to be rejected')
    expect(outcome.simulation.reasons.join(' ')).toMatch(/trigger/i)
    expect(executeSpy).not.toHaveBeenCalled()
    expect(rows()).toEqual(beforeRows)
  })

  it('executes a valid SELECT and validates it against SQLite', () => {
    const executeSpy = vi.spyOn(db, 'executeBatch')
    const beforeRows = rows()
    const outcome = simulateAndValidate(
      'SELECT id, label FROM items ORDER BY id',
      ['SELECT id, label FROM items ORDER BY id'],
      db,
    )

    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.execution).not.toBeNull()
    expect(outcome.validation?.validated).toBe(true)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual(beforeRows)
  })

  it('executes a valid read-only CTE SELECT and preserves parity', () => {
    const executeSpy = vi.spyOn(db, 'executeBatch')
    const sql = 'WITH x AS (SELECT id, label FROM items WHERE id = 1) SELECT id, label FROM x'
    const outcome = simulateAndValidate(sql, [sql], db)

    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.execution?.values).toEqual([[1, 'one']])
    expect(outcome.validation?.validated).toBe(true)
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  it('accepts a comment-prefixed valid SELECT', () => {
    const sql = '-- leading comment\nSELECT id, label FROM items ORDER BY id'
    const outcome = simulateAndValidate(sql, splitStatements(sql), db)
    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
  })
})

describe('normal Run remains writable', () => {
  it('still executes DML and DDL through the normal database store', async () => {
    await createDatabase({ name: 'Writable Run', template: 'blank' })
    const store = useDatabaseStore.getState()

    expect((await store.execute('CREATE TABLE run_items (id INTEGER PRIMARY KEY, label TEXT)')).success).toBe(true)
    expect((await store.execute("INSERT INTO run_items (id, label) VALUES (1, 'one')")).success).toBe(true)
    expect((await store.execute("UPDATE run_items SET label = 'updated' WHERE id = 1")).success).toBe(true)
    expect((await store.execute('DELETE FROM run_items WHERE id = 1')).success).toBe(true)
    expect((await store.execute('DROP TABLE run_items')).success).toBe(true)

    expect(
      getLiveDatabase()?.queryAll("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_items'").values,
    ).toEqual([])
  })
})
