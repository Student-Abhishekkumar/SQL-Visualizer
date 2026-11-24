// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from './Sidebar'
import { useUIStore } from '../../store/uiStore'
import { useHistoryStore } from '../../store/historyStore'
import { useDatabaseStore } from '../../store/databaseStore'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** A stand-in for the real Navbar toggle so focus restoration has a target. */
function Harness() {
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  return (
    <>
      <button type="button" onClick={toggleSidebar} aria-label="Toggle sidebar">
        Toggle
      </button>
      <Sidebar />
    </>
  )
}

beforeEach(() => {
  cleanup()
  document.body.style.overflow = ''
  useUIStore.setState({ isSidebarOpen: false })
  useHistoryStore.setState({ history: [], savedQueries: [] })
  useDatabaseStore.setState({
    status: 'ready',
    schema: null,
    activeDatabaseId: null,
    databases: [],
  })
})

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

describe('Sidebar desktop', () => {
  it('renders a persistent workspace navigation landmark with sections', () => {
    render(<Sidebar />)
    expect(
      screen.getByRole('complementary', { name: 'Workspace navigation' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Database explorer' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Saved queries' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Query history' })).toBeInTheDocument()
  })

  it('does not render the mobile drawer while closed', () => {
    render(<Sidebar />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('Sidebar mobile drawer', () => {
  it('opens as a labelled modal dialog and focuses the close control', () => {
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
    toggle.focus()
    fireEvent.click(toggle)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Workspace')
    expect(screen.getByRole('button', { name: 'Close navigation' })).toHaveFocus()
  })

  it('closes on Escape and restores focus to the opening toggle', () => {
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' })
    toggle.focus()
    fireEvent.click(toggle)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })

    expect(useUIStore.getState().isSidebarOpen).toBe(false)
    expect(toggle).toHaveFocus()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes when the backdrop is pressed', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    const backdrop = document.querySelector('[data-drawer-backdrop]')
    expect(backdrop).not.toBeNull()

    fireEvent.pointerDown(backdrop as Element, { button: 0 })
    expect(useUIStore.getState().isSidebarOpen).toBe(false)
  })

  it('locks background scrolling while open and restores it on close', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    expect(document.body.style.overflow).toBe('hidden')

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(document.body.style.overflow).toBe('')
  })

  it('keeps Tab focus inside the drawer', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    const dialog = screen.getByRole('dialog')
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    const last = focusable.at(-1)
    expect(last).toBeDefined()

    last!.focus()
    fireEvent.keyDown(last!, { key: 'Tab' })
    expect(focusable[0]).toHaveFocus()
  })

  it('hides the drawer from assistive technology while it animates closed', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
    const panel = document.querySelector('[data-drawer-panel]')
    expect(panel).not.toBeNull()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(panel?.parentElement?.getAttribute('aria-hidden')).toBe('true')
  })
})