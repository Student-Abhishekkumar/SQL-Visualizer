import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  closeDatabase,
  initializeDatabase,
  persistDatabase,
  resetDatabase,
} from './databaseInitializer'
import {
  clearDatabaseSnapshot,
  loadDatabaseSnapshot,
} from '../persistence/persistenceService'

/**
 * DatabaseInitializer integration tests. Uses fake-indexeddb so the
 * IndexedDB persistence layer is exercised end-to-end in Node.
 */

beforeEach(async () => {
  closeDatabase()
  await clearDatabaseSnapshot()
})

describe('initializeDatabase', () => {
  it('seeds a fresh University Database on first run', async () => {
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

  it('falls back to seeding when the stored snapshot is corrupt', async () => {
    await saveJunkSnapshot()
    const result = await initializeDatabase()
    expect(result.restored).toBe(false)
    expect(result.db.queryAll('SELECT COUNT(*) FROM employees').values[0]?.[0]).toBe(8)
    // Junk snapshot removed, real one saved.
    const snapshot = await loadDatabaseSnapshot()
    expect(snapshot?.length).toBeGreaterThan(0)
  })
})

describe('resetDatabase', () => {
  it('restores the original seed data after user changes', async () => {
    const first = await initializeDatabase()
    // Insert rows the seed never had (FK-safe).
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

    await resetDatabase()
    const live = await initializeDatabase()
    const names = live.db
      .queryAll("SELECT name FROM sqlite_master WHERE type='table'")
      .values.map((row) => String(row[0]))
    expect(names).not.toContain('clubs')
  })
})

async function saveJunkSnapshot(): Promise<void> {
  const m = await import('../persistence/persistenceService')
  await m.saveDatabaseSnapshot(new Uint8Array([1, 2, 3]))
}
