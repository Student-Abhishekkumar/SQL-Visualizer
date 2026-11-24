// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeMenu } from './ThemeMenu'
import { useUIStore } from '../../store/uiStore'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  useUIStore.setState({ theme: 'dark' })
})

afterEach(() => {
  cleanup()
})

describe('ThemeMenu', () => {
  it('lists all nine themes grouped into Classic and Visual Styles', () => {
    render(<ThemeMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }))
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(9)
    expect(screen.getByText('Classic')).toBeInTheDocument()
    expect(screen.getByText('Visual Styles')).toBeInTheDocument()
  })

  it('marks the active theme and applies a selection immediately', () => {
    render(<ThemeMenu />)
    const trigger = screen.getByRole('button', { name: 'Theme: Dark' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dracula' }))
    expect(useUIStore.getState().theme).toBe('dracula')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on Escape and restores focus to the trigger', () => {
    render(<ThemeMenu />)
    const trigger = screen.getByRole('button', { name: 'Theme: Dark' })
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Themes' }), { key: 'Escape' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('closes on an outside pointer press', () => {
    render(<ThemeMenu />)
    const trigger = screen.getByRole('button', { name: 'Theme: Dark' })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.pointerDown(document.body)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('moves focus with the arrow keys, Home and End', () => {
    render(<ThemeMenu />)
    fireEvent.click(screen.getByRole('button', { name: 'Theme: Dark' }))

    const dark = screen.getByRole('menuitemradio', { name: 'Dark' })
    expect(dark).toHaveFocus()

    fireEvent.keyDown(dark, { key: 'ArrowDown' })
    const midnight = screen.getByRole('menuitemradio', { name: 'Midnight' })
    expect(midnight).toHaveFocus()

    fireEvent.keyDown(midnight, { key: 'End' })
    expect(screen.getByRole('menuitemradio', { name: 'Cyberpunk' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Cyberpunk' }), {
      key: 'Home',
    })
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveFocus()
  })
})