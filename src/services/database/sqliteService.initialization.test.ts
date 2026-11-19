import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { initSqlJsMock } = vi.hoisted(() => ({ initSqlJsMock: vi.fn() }))

vi.mock('sql.js', async () => {
  const actual = await vi.importActual<typeof import('sql.js')>('sql.js')
  return { ...actual, default: initSqlJsMock }
})

import {
  SQLiteDatabase,
  disposeSqlJsRuntime,
  loadSqlJs,
} from './sqliteService'

const realInitSqlJs = (await vi.importActual<typeof import('sql.js')>('sql.js')).default

beforeEach(() => {
  disposeSqlJsRuntime()
  initSqlJsMock.mockReset()
  initSqlJsMock.mockImplementation(realInitSqlJs)
})

afterEach(() => {
  disposeSqlJsRuntime()
  initSqlJsMock.mockReset()
})

describe('recoverable SQL.js initialization', () => {
  it('retries a failed initialization and supports real database operations after recovery', async () => {
    initSqlJsMock.mockRejectedValueOnce(new Error('WASM download failed'))
    await expect(loadSqlJs()).rejects.toThrow('WASM download failed')
    expect(initSqlJsMock).toHaveBeenCalledTimes(1)

    await expect(loadSqlJs()).resolves.toBeDefined()
    expect(initSqlJsMock).toHaveBeenCalledTimes(2)

    const db = await SQLiteDatabase.create()
    db.executeBatch('CREATE TABLE recovered (id INTEGER PRIMARY KEY); INSERT INTO recovered VALUES (1)')
    expect(db.queryAll('SELECT id FROM recovered').values).toEqual([[1]])
    expect(initSqlJsMock).toHaveBeenCalledTimes(2)

    const restored = await SQLiteDatabase.create(undefined, db.exportSnapshot())
    expect(restored.queryAll('SELECT id FROM recovered').values).toEqual([[1]])
    expect(initSqlJsMock).toHaveBeenCalledTimes(2)
    restored.close()
    db.close()
  })

  it('shares concurrent calls and reuses the successful module', async () => {
    const first = loadSqlJs()
    const concurrent = loadSqlJs()
    expect(concurrent).toBe(first)

    const [firstModule, concurrentModule] = await Promise.all([first, concurrent])
    expect(concurrentModule).toBe(firstModule)
    expect(initSqlJsMock).toHaveBeenCalledTimes(1)

    await expect(loadSqlJs()).resolves.toBe(firstModule)
    expect(initSqlJsMock).toHaveBeenCalledTimes(1)
  })

  it('shares a rejected attempt without caching the rejection', async () => {
    initSqlJsMock.mockRejectedValueOnce(new Error('WASM initialization failed'))
    const first = loadSqlJs()
    const concurrent = loadSqlJs()
    expect(concurrent).toBe(first)

    const attempts = await Promise.allSettled([first, concurrent])
    expect(attempts.map((attempt) => attempt.status)).toEqual(['rejected', 'rejected'])
    expect(initSqlJsMock).toHaveBeenCalledTimes(1)

    await expect(loadSqlJs()).resolves.toBeDefined()
    expect(initSqlJsMock).toHaveBeenCalledTimes(2)
  })
})
