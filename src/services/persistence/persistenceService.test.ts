import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openDBMock } = vi.hoisted(() => ({ openDBMock: vi.fn() }))

vi.mock('idb', async () => {
  const actual = await vi.importActual<typeof import('idb')>('idb')
  return { ...actual, openDB: openDBMock }
})

import {
  clearAllDatabaseData,
  closePersistence,
  loadActiveDatabaseId,
  loadDatabaseRecords,
  loadDatabaseSnapshot,
  saveActiveDatabaseId,
  saveDatabaseSnapshot,
} from './persistenceService'

const realOpenDB = (await vi.importActual<typeof import('idb')>('idb')).openDB

beforeEach(async () => {
  closePersistence()
  openDBMock.mockReset()
  openDBMock.mockImplementation(realOpenDB)
  await clearAllDatabaseData({ includeHistory: true, includeSavedQueries: true })
  closePersistence()
  openDBMock.mockClear()
})

afterEach(() => {
  closePersistence()
  openDBMock.mockReset()
})

describe('recoverable IndexedDB initialization', () => {
  it('retries an initial open failure and persists normally after recovery and reload', async () => {
    openDBMock.mockRejectedValueOnce(new Error('IndexedDB temporarily unavailable'))
    await expect(loadDatabaseRecords()).rejects.toThrow('IndexedDB temporarily unavailable')
    expect(openDBMock).toHaveBeenCalledTimes(1)

    const bytes = new Uint8Array([1, 2, 3, 4])
    await expect(saveDatabaseSnapshot(bytes, 'recovered')).resolves.toBe(true)
    expect(openDBMock).toHaveBeenCalledTimes(2)
    expect(await loadDatabaseSnapshot('recovered')).toEqual(bytes)

    closePersistence()
    expect(await loadDatabaseSnapshot('recovered')).toEqual(bytes)
    expect(openDBMock).toHaveBeenCalledTimes(3)
  })

  it('shares concurrent initialization and reuses the successful connection', async () => {
    const [records, snapshotSaved, activeSaved] = await Promise.all([
      loadDatabaseRecords(),
      saveDatabaseSnapshot(new Uint8Array([5, 6]), 'concurrent'),
      saveActiveDatabaseId('concurrent'),
    ])

    expect(records).toEqual([])
    expect(snapshotSaved).toBe(true)
    expect(activeSaved).toBe(true)
    expect(openDBMock).toHaveBeenCalledTimes(1)

    expect(await loadDatabaseSnapshot('concurrent')).toEqual(new Uint8Array([5, 6]))
    expect(await loadActiveDatabaseId()).toBe('concurrent')
    expect(openDBMock).toHaveBeenCalledTimes(1)
  })

  it('shares a failed open, then allows a later open to recover existing data', async () => {
    const bytes = new Uint8Array([7, 8, 9])
    expect(await saveDatabaseSnapshot(bytes, 'existing')).toBe(true)
    closePersistence()
    openDBMock.mockClear()
    openDBMock.mockRejectedValueOnce(new Error('Reopen failed'))

    const attempts = await Promise.allSettled([
      loadDatabaseSnapshot('existing'),
      loadDatabaseRecords(),
    ])
    expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected'])
    expect(openDBMock).toHaveBeenCalledTimes(1)

    expect(await loadDatabaseSnapshot('existing')).toEqual(bytes)
    expect(openDBMock).toHaveBeenCalledTimes(2)
  })
})
