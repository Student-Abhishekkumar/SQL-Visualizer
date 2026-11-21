import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteDatabase } from '../database/sqliteService'
import {
  createDatabase, getActiveDatabaseId, getLiveDatabase, persistActiveDatabase,
  resetDatabaseManagerForTests,
} from '../database/databaseManager'
import {
  clearAllDatabaseData, loadActiveDatabaseId, loadDatabaseSnapshot,
} from '../persistence/persistenceService'
import { simulateAndValidate } from './validation'
import { useVisualizationStore } from '../../store/visualizationStore'

beforeEach(async () => {
  resetDatabaseManagerForTests()
  await clearAllDatabaseData({ includeHistory: true, includeSavedQueries: true })
})
afterEach(() => {
  getLiveDatabase()?.close()
  resetDatabaseManagerForTests()
  useVisualizationStore.getState().clear()
  vi.restoreAllMocks()
})

function watchClones(): Array<ReturnType<typeof vi.spyOn>> {
  const closeSpies: Array<ReturnType<typeof vi.spyOn>> = []
  const create = SQLiteDatabase.createFromSnapshot.bind(SQLiteDatabase)
  vi.spyOn(SQLiteDatabase, 'createFromSnapshot').mockImplementation((bytes) => {
    const clone = create(bytes)
    closeSpies.push(vi.spyOn(clone, 'close'))
    return clone
  })
  return closeSpies
}

async function managedDatabase() {
  const { info } = await createDatabase({ name: 'Preview safety', template: 'blank' })
  const db = getLiveDatabase()
  if (db === null) throw new Error('No active database')
  db.runRaw("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE); INSERT INTO items VALUES (1, 'one')")
  await persistActiveDatabase(db)
  return { info, db }
}

async function expectStoredStateUnchanged(id: string, db: SQLiteDatabase, liveBytes: Uint8Array, storedBytes: Uint8Array) {
  expect(db.exportSnapshot()).toEqual(liveBytes)
  expect(await loadDatabaseSnapshot(id)).toEqual(storedBytes)
  expect(getActiveDatabaseId()).toBe(id)
  expect(await loadActiveDatabaseId()).toBe(id)
  expect(getLiveDatabase()).toBe(db)
  expect(db.queryAll('SELECT id, name FROM items ORDER BY id').values).toEqual([[1, 'one']])
}

describe('DML preview active-database and persistence safety', () => {
  it('closes the clone after success without changing bytes, stored snapshot, selection, or usability', async () => {
    const { info, db } = await managedDatabase()
    const liveBytes = db.exportSnapshot()
    const storedBytes = await loadDatabaseSnapshot(info.id)
    if (storedBytes === null) throw new Error('Missing stored snapshot')
    const clones = watchClones()
    const activeExecute = vi.spyOn(db, 'executeBatch')
    const outcome = simulateAndValidate("INSERT INTO items (id, name) VALUES (2, 'two')", ["INSERT INTO items (id, name) VALUES (2, 'two')"], db)

    expect(outcome.simulation.ok).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(activeExecute).not.toHaveBeenCalled()
    expect(clones).toHaveLength(1)
    expect(clones[0]).toHaveBeenCalledTimes(1)
    await expectStoredStateUnchanged(info.id, db, liveBytes, storedBytes)
    db.runRaw("INSERT INTO items (id, name) VALUES (3, 'still usable')")
    expect(db.queryAll('SELECT COUNT(*) FROM items').values).toEqual([[2]])
  })

  it('closes the clone after a SQLite constraint failure and preserves all active state', async () => {
    const { info, db } = await managedDatabase()
    const liveBytes = db.exportSnapshot()
    const storedBytes = await loadDatabaseSnapshot(info.id)
    if (storedBytes === null) throw new Error('Missing stored snapshot')
    const clones = watchClones()
    const outcome = simulateAndValidate("INSERT INTO items (id, name) VALUES (2, 'one')", ["INSERT INTO items (id, name) VALUES (2, 'one')"], db)

    expect(outcome.simulation.ok).toBe(false)
    if (outcome.simulation.ok) throw new Error('Expected UNIQUE failure')
    expect(outcome.simulation.reasons.join(' ')).toMatch(/UNIQUE|constraint/i)
    expect(clones).toHaveLength(1)
    expect(clones[0]).toHaveBeenCalledTimes(1)
    await expectStoredStateUnchanged(info.id, db, liveBytes, storedBytes)
  })

  it('discards a parity mismatch instead of returning a successful trace', async () => {
    const db = await SQLiteDatabase.create()
    try {
      db.runRaw('CREATE TABLE randomized (id INTEGER PRIMARY KEY, value INTEGER DEFAULT (random()))')
      const before = db.exportSnapshot()
      const clones = watchClones()
      const outcome = simulateAndValidate('INSERT INTO randomized DEFAULT VALUES', ['INSERT INTO randomized DEFAULT VALUES'], db)
      expect(outcome.simulation.ok).toBe(false)
      if (outcome.simulation.ok) throw new Error('Expected random-default parity rejection')
      expect(outcome.simulation.reasons.join(' ')).toMatch(/did not match SQLite|discarded/i)
      expect(clones[0]).toHaveBeenCalledTimes(1)
      expect(db.exportSnapshot()).toEqual(before)
    } finally {
      db.close()
    }
  })

  it('rejects over-limit target tables rather than validating a truncated final state', async () => {
    const db = await SQLiteDatabase.create()
    try {
      db.runRaw('CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)')
      db.runRaw('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x <= 500) INSERT INTO items SELECT x, x FROM n')
      const before = db.exportSnapshot()
      const outcome = simulateAndValidate("UPDATE items SET value = 'changed' WHERE id = 501", ["UPDATE items SET value = 'changed' WHERE id = 501"], db)
      expect(outcome.simulation.ok).toBe(false)
      if (outcome.simulation.ok) throw new Error('Expected row-limit rejection')
      expect(outcome.simulation.reasons.join(' ')).toMatch(/at most 500 rows/i)
      expect(db.exportSnapshot()).toEqual(before)
    } finally {
      db.close()
    }
  })
})

describe('DML visualization store integration', () => {
  it('loads DML into the existing store and Table View playback state', async () => {
    const { info, db } = await managedDatabase()
    const liveBytes = db.exportSnapshot()
    const storedBytes = await loadDatabaseSnapshot(info.id)
    if (storedBytes === null) throw new Error('Missing stored snapshot')
    const sql = "UPDATE items SET name = 'preview' WHERE id = 1"
    useVisualizationStore.getState().visualize(sql, [sql])
    const state = useVisualizationStore.getState()
    expect(state.status).toBe('ready')
    expect(state.actualRowCount).toBe(1)
    expect(state.trace?.dml?.operation).toBe('UPDATE')
    state.jumpToEnd()
    expect(useVisualizationStore.getState().viewState.snapshot?.stage).toBe('FINAL_TABLE')
    expect(useVisualizationStore.getState().viewState.snapshot?.rows.map((row) => row.values)).toEqual([[1, 'preview']])
    await expectStoredStateUnchanged(info.id, db, liveBytes, storedBytes)
  })
})
