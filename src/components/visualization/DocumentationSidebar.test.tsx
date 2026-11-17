// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { StageSnapshot } from '../../types/visualization'
import {
  DocumentationEdgeTab,
  DocumentationSidebar,
} from './DocumentationSidebar'

/**
 * Sidebar shell behaviour. The regression these tests protect against:
 * the shell used `overflow: hidden`, which is still a scroll container, so
 * the browser could scroll it (for example to reveal an overflowing tooltip
 * or a focused control) and leave the whole panel permanently shifted with
 * its left edge clipped. The shell must clip without being scrollable, and
 * the content area must be the only scroll container.
 */

function whereSnapshot(): StageSnapshot {
  return {
    stage: 'WHERE',
    label: 'WHERE salary > 50000',
    columns: ['name', 'salary'],
    rows: [
      { id: 'r1', values: ['Amit', 90000] },
      { id: 'r2', values: ['Priya', 55000] },
    ],
    removedRows: [{ id: 'r3', values: ['Neha', 28000] }],
    roles: { r1: 'accepted', r2: 'accepted', r3: 'filtered' },
    groups: [],
    explanation: '1 row failed the condition and was removed.',
    inputRowCount: 3,
    outputRowCount: 2,
    truncated: false,
  }
}

beforeEach(() => {
  // jsdom has no matchMedia; motion's useReducedMotion needs it.
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }))
})

afterEach(() => {
  cleanup()
})

describe('DocumentationSidebar', () => {
  it('is hidden from layout and accessibility while closed, but stays mounted', () => {
    const { rerender } = render(
      <DocumentationSidebar open stage={null} snapshot={null} onClose={() => {}} />,
    )
    const sidebar = screen.getByTestId('documentation-sidebar')
    expect(sidebar).toHaveAttribute('data-state', 'open')
    expect(sidebar).not.toHaveAttribute('aria-hidden')
    expect(sidebar.style.width).not.toBe('0px')

    rerender(<DocumentationSidebar open={false} stage={null} snapshot={null} onClose={() => {}} />)
    const closed = screen.getByTestId('documentation-sidebar')
    expect(closed).toBe(sidebar)
    expect(closed).toHaveAttribute('data-state', 'closed')
    expect(closed).toHaveAttribute('aria-hidden', 'true')
    expect(closed).toHaveAttribute('inert')
    expect(closed).toHaveStyle({ width: '0px' })
  })

  it('closes from its header button and exposes an edge-tab opener', () => {
    const onClose = vi.fn()
    const onOpen = vi.fn()
    render(
      <>
        <DocumentationSidebar open stage={null} snapshot={null} onClose={onClose} />
        <DocumentationEdgeTab onOpen={onOpen} />
      </>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close documentation sidebar' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Open documentation sidebar' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('clips its shell without becoming scrollable, so content cannot shift', () => {
    render(<DocumentationSidebar open stage="WHERE" snapshot={whereSnapshot()} onClose={() => {}} />)
    const sidebar = screen.getByTestId('documentation-sidebar')

    // `overflow: hidden` would still be scrollable; `overflow: clip` is not.
    expect(sidebar).toHaveClass('overflow-clip')
    expect(sidebar).not.toHaveClass('overflow-hidden')
  })

  it('sizes its inner panel from the sidebar instead of a fixed width', () => {
    render(<DocumentationSidebar open stage="WHERE" snapshot={whereSnapshot()} onClose={() => {}} />)
    const sidebar = screen.getByTestId('documentation-sidebar')
    const shell = sidebar.firstElementChild as HTMLElement

    // A fixed `w-80` panel overflowed the overlay below ~372px of workspace
    // width and was clipped horizontally.
    expect(shell).toHaveClass('w-full')
    expect(shell).toHaveClass('min-w-0')
    expect(shell.className).not.toMatch(/(^|\s)w-80(\s|$)/)
    expect(shell.className).not.toMatch(/@4xl:w-72/)
  })

  it('keeps one vertical scroll container for the documentation content', () => {
    render(<DocumentationSidebar open stage="WHERE" snapshot={whereSnapshot()} onClose={() => {}} />)
    const panel = screen.getByRole('complementary', { name: 'Explanation' })

    expect(panel).toHaveClass('overflow-y-auto')
    expect(panel).toHaveClass('overflow-x-hidden')
    expect(panel).toHaveClass('min-h-0')
    expect(panel).toHaveClass('min-w-0')
  })
})
