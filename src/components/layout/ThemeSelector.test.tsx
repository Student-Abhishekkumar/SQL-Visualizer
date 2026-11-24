// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeSelector } from './ThemeSelector'
import { useUIStore } from '../../store/uiStore'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  useUIStore.setState({ theme: 'dark' })
})

afterEach(() => {
  cleanup()
})

describe('ThemeSelector', () => {
  it('renders all nine themes grouped into Classic and Visual Styles', () => {
    render(<ThemeSelector />)
    expect(screen.getByRole('radiogroup', { name: 'Color theme' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Classic' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Visual Styles' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(9)
  })

  it('marks the active theme and switches without a page reload', () => {
    render(<ThemeSelector />)
    const nord = screen.getByRole('radio', { name: 'Nord theme' })
    expect(nord).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(nord)
    expect(nord).toHaveAttribute('aria-checked', 'true')
    expect(useUIStore.getState().theme).toBe('nord')
  })

  it('uses a roving tabindex so only the active theme is a Tab stop', () => {
    render(<ThemeSelector />)
    const radios = screen.getAllByRole('radio')
    const active = radios.find((radio) => radio.getAttribute('aria-checked') === 'true')
    expect(active).toBeDefined()
    expect(active).toHaveAttribute('tabindex', '0')
    expect(
      radios
        .filter((radio) => radio !== active)
        .every((radio) => radio.getAttribute('tabindex') === '-1'),
    ).toBe(true)
  })

  it('moves selection and focus with the arrow keys', () => {
    render(<ThemeSelector />)
    const radios = screen.getAllByRole('radio')
    const active = radios.find((radio) => radio.getAttribute('aria-checked') === 'true')!
    const activeIndex = radios.indexOf(active)

    fireEvent.keyDown(active, { key: 'ArrowRight' })
    const next = radios[(activeIndex + 1) % radios.length]!
    expect(next).toHaveAttribute('aria-checked', 'true')
    expect(next).toHaveFocus()
    expect(useUIStore.getState().theme).toBe('midnight')

    fireEvent.keyDown(next, { key: 'ArrowLeft' })
    expect(active).toHaveAttribute('aria-checked', 'true')
    expect(active).toHaveFocus()
  })

  it('jumps to the first and last themes with Home and End', () => {
    render(<ThemeSelector />)
    const radios = screen.getAllByRole('radio')
    const active = radios.find((radio) => radio.getAttribute('aria-checked') === 'true')!

    fireEvent.keyDown(active, { key: 'End' })
    expect(radios[radios.length - 1]).toHaveAttribute('aria-checked', 'true')
    expect(radios[radios.length - 1]).toHaveFocus()

    fireEvent.keyDown(radios[radios.length - 1]!, { key: 'Home' })
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    expect(radios[0]).toHaveFocus()
  })

  it('exposes a descriptive accessible name for every theme', () => {
    render(<ThemeSelector />)
    expect(screen.getByRole('radio', { name: 'Light theme' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Cyberpunk theme' })).toBeInTheDocument()
  })
})