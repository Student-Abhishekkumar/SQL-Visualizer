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
  const { info } = await createDatabase({ name: 'DDL preview safety', template: 'blank' })
  const db = getLiveDatabase()
  if (db === null) throw new Error('No active database')
  db.runRaw("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE); INSERT INTO items VALUES (1, 'one')")
  await persistActiveDatabase(db)
  return { info, db }
}

async function captureState(id: string, db: SQLiteDatabase) {
  const storedBytes = await loadDatabaseSnapshot(id)
  if (storedBytes === null) throw new Error('Missing stored snapshot')
  return { liveBytes: db.exportSnapshot(), storedBytes }
}

async function expectStoredStateUnchanged(
  id: string,
  db: SQLiteDatabase,
  state: { liveBytes: Uint8Array; storedBytes: Uint8Array },
) {
  expect(db.exportSnapshot()).toEqual(state.liveBytes)
  expect(await loadDatabaseSnapshot(id)).toEqual(state.storedBytes)
  expect(getActiveDatabaseId()).toBe(id)
  expect(await loadActiveDatabaseId()).toBe(id)
  expect(getLiveDatabase()).toBe(db)
  expect(db.queryAll('SELECT id, name FROM items ORDER BY id').values).toEqual([[1, 'one']])
}

describe('DDL preview active-database and persistence safety', () => {
  it.each([
    ['CREATE TABLE', 'CREATE TABLE added (id INTEGER PRIMARY KEY, label TEXT)'],
    ['ALTER TABLE', "ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'preview'"],
    ['DROP TABLE', 'DROP TABLE items'],
    ['CREATE INDEX', 'CREATE INDEX items_name ON items(name)'],
    ['DROP INDEX', 'DROP INDEX IF EXISTS missing_index'],
  ])('closes the clone after %s success without changing active or stored state', async (_name, sql) => {
    const { info, db } = await managedDatabase()
    const state = await captureState(info.id, db)
    const clones = watchClones()
    const activeExecute = vi.spyOn(db, 'executeBatch')
    const outcome = simulateAndValidate(sql, [sql], db)

    expect(outcome.simulation.ok, outcome.simulation.ok ? '' : outcome.simulation.reasons.join('; ')).toBe(true)
    expect(outcome.validation?.validated).toBe(true)
    expect(activeExecute).not.toHaveBeenCalled()
    expect(clones).toHaveLength(1)
    expect(clones[0]).toHaveBeenCalledTimes(1)
    await expectStoredStateUnchanged(info.id, db, state)
    db.runRaw("INSERT INTO items (id, name) VALUES (2, 'still usable')")
    expect(db.queryAll('SELECT COUNT(*) FROM items').values).toEqual([[2]])
  })

  it('closes the clone after SQLite failure and preserves every active state boundary', async () => {
    const { info, db } = await managedDatabase()
    const state = await captureState(info.id, db)
    const clones = watchClones()
    const activeExecute = vi.spyOn(db, 'executeBatch')
    const outcome = simulateAndValidate('CREATE TABLE items (id INTEGER)', ['CREATE TABLE items (id INTEGER)'], db)

    expect(outcome.simulation.ok).toBe(false)
    expect(activeExecute).not.toHaveBeenCalled()
    expect(clones).toHaveLength(1)
    expect(clones[0]).toHaveBeenCalledTimes(1)
    await expectStoredStateUnchanged(info.id, db, state)
  })
})

describe('DDL visualization store integration', () => {
  it('loads schema snapshots into existing playback without persisting the preview', async () => {
    const { info, db } = await managedDatabase()
    const state = await captureState(info.id, db)
    const sql = "ALTER TABLE items ADD COLUMN note TEXT DEFAULT 'preview'"
    useVisualizationStore.getState().visualize(sql, [sql])
    const current = useVisualizationStore.getState()
    expect(current.status).toBe('ready')
    expect(current.actualRowCount).toBe(0)
    expect(current.trace?.ddl?.operation).toBe('ALTER_TABLE')
    current.jumpToEnd()
    expect(useVisualizationStore.getState().viewState.snapshot?.stage).toBe('RESULTING_SCHEMA')
    expect(useVisualizationStore.getState().viewState.snapshot?.schema?.table?.columns.map((column) => column.name)).toEqual([
      'id', 'name', 'note',
    ])
    await expectStoredStateUnchanged(info.id, db, state)
  })
})
