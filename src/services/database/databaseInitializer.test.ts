import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  closeDatabase,
  initializeDatabase,
  persistDatabase,
  resetDatabase,
} from './databaseInitializer'
import {
  clearAllDatabaseData,
  deleteDatabaseSnapshot,
  loadDatabaseSnapshot,
  saveDatabaseSnapshot,
} from '../persistence/persistenceService'
import {
  getActiveDatabaseId,
  resetDatabaseManagerForTests,
} from './databaseManager'

/**
 * Database lifecycle integration tests. Uses fake-indexeddb so the
 * multi-database persistence layer is exercised end-to-end in Node.
 */

beforeEach(async () => {
  resetDatabaseManagerForTests()
  await clearAllDatabaseData({ includeHistory: true, includeSavedQueries: true })
})

describe('initializeDatabase', () => {
  it('creates the optional Example Database on first run', async () => {
    const result = await initializeDatabase()
    expect(result.restored).toBe(false)
    const names = result.schema.tables.map((table) => table.name)
    expect(names).toContain('employees')
    expect(names).toContain('departments')

    const employees = result.db.queryAll('SELECT COUNT(*) FROM employees')
    expect(employees.values[0]?.[0]).toBe(8)
  })

  it('reuses the live connection on repeated calls', async () => {
    const first = await initializeDatabase()
    const second = await initializeDatabase()
    expect(second.db).toBe(first.db)
    expect(second.restored).toBe(true)
  })

  it('restores persisted state including user modifications', async () => {
    const first = await initializeDatabase()
    first.db.executeBatch(
      "INSERT INTO employees (id, name, department_id, salary, age, city) VALUES (9, 'Vikram', 1, 55000, 24, 'Jaipur')",
    )
    await persistDatabase(first.db)
    closeDatabase()

    const second = await initializeDatabase()
    expect(second.restored).toBe(true)
    expect(second.db.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(9)
  })

  it('preserves a corrupt snapshot for inspection and retries without replacing user data', async () => {
    const first = await initializeDatabase()
    first.db.executeBatch(
      "INSERT INTO employees (id, name, department_id, salary, age, city) VALUES (9, 'Vikram', 1, 55000, 24, 'Jaipur')",
    )
    await persistDatabase(first.db)
    const id = getActiveDatabaseId()
    expect(id).not.toBeNull()
    const validSnapshot = await loadDatabaseSnapshot(id as string)
    expect(validSnapshot).not.toBeNull()
    const corruptSnapshot = new Uint8Array([1, 2, 3])
    await saveDatabaseSnapshot(corruptSnapshot, id as string)
    closeDatabase()

    await expect(initializeDatabase()).rejects.toThrow(/corrupt|unreadable/i)
    expect(await loadDatabaseSnapshot(id as string)).toEqual(corruptSnapshot)

    await saveDatabaseSnapshot(validSnapshot as Uint8Array, id as string)
    const recovered = await initializeDatabase()
    expect(recovered.restored).toBe(true)
    expect(recovered.db.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(9)
  })

  it('distinguishes a missing snapshot and recovers only after a backup is restored', async () => {
    await initializeDatabase()
    const id = getActiveDatabaseId()
    expect(id).not.toBeNull()
    const validSnapshot = await loadDatabaseSnapshot(id as string)
    expect(validSnapshot).not.toBeNull()
    await deleteDatabaseSnapshot(id as string)
    closeDatabase()

    await expect(initializeDatabase()).rejects.toThrow(/snapshot.*missing/i)
    expect(await loadDatabaseSnapshot(id as string)).toBeNull()

    await saveDatabaseSnapshot(validSnapshot as Uint8Array, id as string)
    const recovered = await initializeDatabase()
    expect(recovered.db.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)
  })
})

describe('resetDatabase', () => {
  it('restores the original seed data after user changes', async () => {
    const first = await initializeDatabase()
    first.db.executeBatch(
      "INSERT INTO employees (id, name, department_id, salary, age, city) VALUES (9, 'Vikram', 1, 55000, 24, 'Jaipur')",
    )
    await persistDatabase(first.db)

    const schema = await resetDatabase()
    expect(schema.tables.map((table) => table.name)).toContain('employees')

    const live = await initializeDatabase()
    expect(live.db).not.toBe(first.db)
    expect(live.db.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)
  })

  it('removes user-created tables', async () => {
    const first = await initializeDatabase()
    first.db.executeBatch('CREATE TABLE clubs (id INTEGER PRIMARY KEY, club_name TEXT)')
    await persistDatabase(first.db)

    await resetDatabase()
    const live = await initializeDatabase()
    const names = live.db
      .queryAll("SELECT name FROM sqlite_master WHERE type='table'")
      .values.map((row) => String(row[0]))
    expect(names).not.toContain('clubs')
  })
})
