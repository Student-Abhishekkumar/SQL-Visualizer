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

describe('WorkspaceViewToggle accessibility', () => {
  it('uses a roving tabindex so only the active tab is a Tab stop', () => {
    render(<WorkspaceViewToggle />)
    expect(screen.getByRole('tab', { name: 'Query' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Canvas' })).toHaveAttribute('tabindex', '-1')
  })

  it('wires each tab to its workspace panel', () => {
    render(<WorkspaceViewToggle />)
    expect(screen.getByRole('tab', { name: 'Query' })).toHaveAttribute(
      'aria-controls',
      'workspace-panel-query',
    )
    expect(screen.getByRole('tab', { name: 'Canvas' })).toHaveAttribute(
      'aria-controls',
      'workspace-panel-canvas',
    )
  })

  it('moves selection and focus with the arrow keys', () => {
    render(<WorkspaceViewToggle />)
    const query = screen.getByRole('tab', { name: 'Query' })
    const canvas = screen.getByRole('tab', { name: 'Canvas' })

    query.focus()
    fireEvent.keyDown(query, { key: 'ArrowRight' })
    expect(canvas).toHaveAttribute('aria-selected', 'true')
    expect(canvas).toHaveFocus()
    expect(useUIStore.getState().workspaceView).toBe('canvas')

    fireEvent.keyDown(canvas, { key: 'ArrowLeft' })
    expect(query).toHaveAttribute('aria-selected', 'true')
    expect(query).toHaveFocus()
  })

  it('wraps with Home and End', () => {
    render(<WorkspaceViewToggle />)
    const query = screen.getByRole('tab', { name: 'Query' })
    const canvas = screen.getByRole('tab', { name: 'Canvas' })

    fireEvent.keyDown(query, { key: 'End' })
    expect(canvas).toHaveAttribute('aria-selected', 'true')
    expect(canvas).toHaveFocus()

    fireEvent.keyDown(canvas, { key: 'Home' })
    expect(query).toHaveAttribute('aria-selected', 'true')
    expect(query).toHaveFocus()
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
