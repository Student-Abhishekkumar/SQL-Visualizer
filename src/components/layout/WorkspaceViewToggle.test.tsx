// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceViewToggle } from './WorkspaceViewToggle'
import { useUIStore } from '../../store/uiStore'
import { useDatabaseStore } from '../../store/databaseStore'
import {
  createDatabase,
  resetDatabaseManagerForTests,
} from '../../services/database/databaseManager'
import { clearAllDatabaseData } from '../../services/persistence/persistenceService'

const VIEW_STORAGE_KEY = 'sql-visualizer-view'

async function loadFreshUIStore() {
  vi.resetModules()
  return (await import('../../store/uiStore')).useUIStore
}

beforeEach(async () => {
  cleanup()
  localStorage.clear()
  useUIStore.setState({ workspaceView: 'query', theme: 'dark' })
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
  cleanup()
  resetDatabaseManagerForTests()
})

describe('workspace startup view', () => {
  it('initializes Query on a fresh application launch', async () => {
    const store = await loadFreshUIStore()
    expect(store.getState().workspaceView).toBe('query')
  })

  it('initializes Query on reload even when Canvas was persisted previously', async () => {
    localStorage.setItem(VIEW_STORAGE_KEY, 'canvas')
    localStorage.setItem('sql-visualizer-theme', 'light')
    localStorage.setItem('unrelated-preference', 'preserve-me')

    const store = await loadFreshUIStore()
    expect(store.getState().workspaceView).toBe('query')
    expect(store.getState().theme).toBe('light')
    expect(localStorage.getItem('unrelated-preference')).toBe('preserve-me')
  })
})

describe('WorkspaceViewToggle', () => {
  it('opens on Query and switches freely between Canvas and Query', () => {
    render(<WorkspaceViewToggle />)
    const query = screen.getByRole('tab', { name: 'Query' })
    const canvas = screen.getByRole('tab', { name: 'Canvas' })
    expect(query).toHaveAttribute('aria-selected', 'true')
    expect(canvas).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(canvas)
    expect(canvas).toHaveAttribute('aria-selected', 'true')
    expect(query).toHaveAttribute('aria-selected', 'false')
    expect(useUIStore.getState().workspaceView).toBe('canvas')

    fireEvent.click(query)
    expect(query).toHaveAttribute('aria-selected', 'true')
    expect(canvas).toHaveAttribute('aria-selected', 'false')
    expect(useUIStore.getState().workspaceView).toBe('query')
    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBeNull()
  })

  it('does not reset the active view when switching databases or running SQL', async () => {
    const first = await createDatabase({ name: 'First', template: 'blank' })
    const second = await createDatabase({ name: 'Second', template: 'blank' })
    useUIStore.getState().setWorkspaceView('canvas')

    await useDatabaseStore.getState().openDatabase(first.info.id)
    expect(useUIStore.getState().workspaceView).toBe('canvas')

    await useDatabaseStore.getState().execute('SELECT 1')
    expect(useUIStore.getState().workspaceView).toBe('canvas')

    await useDatabaseStore.getState().openDatabase(second.info.id)
    expect(useUIStore.getState().workspaceView).toBe('canvas')
  })
})
