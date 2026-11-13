// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { StageSnapshot } from '../../types/visualization'
import { ExplanationPanel } from './ExplanationPanel'

/**
 * Explanation panel behavior: learning-level switching changes the
 * concept text, "What happened" derives from the real snapshot, the
 * knowledge check answers with feedback, and advanced mode hides the
 * check and adds no generic content.
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

describe('ExplanationPanel', () => {
  it('renders the beginner concept and derives "What happened" from the snapshot', () => {
    render(<ExplanationPanel stage="WHERE" snapshot={whereSnapshot()} />)

    expect(screen.getByText('WHERE — filter rows')).toBeInTheDocument()
    expect(
      screen.getByText(/WHERE checks every row against a condition/),
    ).toBeInTheDocument()
    expect(screen.getByText('What happened')).toBeInTheDocument()
    expect(screen.getByText(/2 rows passed; 1 was filtered out/)).toBeInTheDocument()
    expect(screen.getByText('Rows in: 3')).toBeInTheDocument()
    expect(screen.getByText('Rows out: 2')).toBeInTheDocument()
  })

  it('switching to Advanced shows the advanced concept and hides the knowledge check', async () => {
    const user = userEvent.setup()
    render(<ExplanationPanel stage="WHERE" snapshot={whereSnapshot()} />)
    expect(screen.getByText(/Knowledge check/i)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Advanced' }))
    expect(
      screen.getByText(/SQLite evaluates predicates with its own opcode loop/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Knowledge check/i)).not.toBeInTheDocument()
  })

  it('knowledge check: a wrong answer shows the explanation and marks the option', async () => {
    const user = userEvent.setup()
    render(<ExplanationPanel stage="WHERE" snapshot={whereSnapshot()} />)

    await user.click(screen.getByRole('button', { name: 'kept in the result' }))

    // Correct option is revealed as such; the chosen wrong one is marked.
    expect((screen.getByRole('button', { name: /filtered out/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.getByText(/treat UNKNOWN as false in WHERE/),
    ).toBeInTheDocument()
  })

  it('knowledge check answer resets when the stage changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ExplanationPanel stage="WHERE" snapshot={whereSnapshot()} />)

    await user.click(screen.getByRole('button', { name: 'kept in the result' }))
    expect(screen.getByText(/treat UNKNOWN as false in WHERE/)).toBeInTheDocument()

    // Move to a different stage: the previous answer must not leak.
    rerender(<ExplanationPanel stage="LIMIT" snapshot={whereSnapshot()} />)
    const limitButtons = screen.getAllByRole('button', { name: /rows 3–5/ }) as HTMLButtonElement[]
    expect(limitButtons[0]?.disabled).toBe(false)
  })

  it('offers trusted sqlite.org documentation for the stage', async () => {
    const user = userEvent.setup()
    render(<ExplanationPanel stage="ORDER_BY" snapshot={{ ...whereSnapshot(), stage: 'ORDER_BY', label: 'ORDER BY salary' }} />)

    await user.click(screen.getByRole('button', { name: /Documentation/ }))
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\/www\.sqlite\.org\//)
    }
    expect(links.some((link) => link.getAttribute('href')?.includes('lang_select'))).toBe(true)
  })

  it('shows the empty state when no stage is active', () => {
    render(<ExplanationPanel stage={null} snapshot={null} />)
    expect(
      screen.getByText(/Start playback or pick a completed stage/),
    ).toBeInTheDocument()
  })
})
