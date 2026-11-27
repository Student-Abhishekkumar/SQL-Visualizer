// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tabs, type TabDefinition } from './Tabs'

const tabs: TabDefinition[] = [
  { id: 'results', label: 'Results' },
  { id: 'messages', label: 'Messages' },
  { id: 'info', label: 'Query Information' },
]

/** Mirrors real usage: the parent owns `active` and re-renders on change. */
function ControlledTabs({ onChange }: { onChange?: (id: string) => void }) {
  const [active, setActive] = useState('results')
  return (
    <Tabs
      tabs={tabs}
      active={active}
      onChange={(id) => {
        setActive(id)
        onChange?.(id)
      }}
    />
  )
}

afterEach(() => {
  cleanup()
})

describe('Tabs', () => {
  it('keeps only the active tab in the tab order', () => {
    render(<ControlledTabs />)
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Messages' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tab', { name: 'Query Information' })).toHaveAttribute(
      'tabindex',
      '-1',
    )
  })

  it('moves selection and focus with the arrow keys', () => {
    const onChange = vi.fn()
    render(<ControlledTabs onChange={onChange} />)
    const results = screen.getByRole('tab', { name: 'Results' })
    const messages = screen.getByRole('tab', { name: 'Messages' })

    results.focus()
    fireEvent.keyDown(results, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('messages')
    expect(messages).toHaveAttribute('aria-selected', 'true')
    expect(messages).toHaveFocus()

    fireEvent.keyDown(messages, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('results')
    expect(results).toHaveAttribute('aria-selected', 'true')
    expect(results).toHaveFocus()
  })

  it('wraps with the arrow keys and jumps with Home and End', () => {
    render(<ControlledTabs />)
    const results = screen.getByRole('tab', { name: 'Results' })
    const info = screen.getByRole('tab', { name: 'Query Information' })

    results.focus()
    fireEvent.keyDown(results, { key: 'ArrowLeft' })
    expect(info).toHaveAttribute('aria-selected', 'true')
    expect(info).toHaveFocus()

    fireEvent.keyDown(info, { key: 'Home' })
    expect(results).toHaveAttribute('aria-selected', 'true')
    expect(results).toHaveFocus()

    fireEvent.keyDown(results, { key: 'End' })
    expect(info).toHaveAttribute('aria-selected', 'true')
    expect(info).toHaveFocus()
  })

  it('falls back to the first tab when the active id is unknown', () => {
    render(<Tabs tabs={tabs} active="stale" onChange={() => {}} />)
    expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('tabindex', '0')
  })
})
