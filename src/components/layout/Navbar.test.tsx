// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Navbar } from './Navbar'
import { useUIStore } from '../../store/uiStore'
import { useDatabaseStore } from '../../store/databaseStore'

beforeEach(() => {
  cleanup()
  localStorage.clear()
  useUIStore.setState({ theme: 'dark', isSidebarOpen: false, isSettingsOpen: false })
  useDatabaseStore.setState({ status: 'ready' })
})

afterEach(() => {
  cleanup()
})

describe('Navbar', () => {
  it('shows the product identity', () => {
    render(<Navbar />)
    expect(screen.getByText('SQL Visualizer')).toBeInTheDocument()
  })

  it('opens the theme menu and applies a selection immediately', () => {
    render(<Navbar />)
    const trigger = screen.getByRole('button', { name: 'Theme: Dark' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menu', { name: 'Themes' })).toBeInTheDocument()
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(9)

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Nord' }))
    expect(useUIStore.getState().theme).toBe('nord')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('reflects sidebar state on the compact navigation toggle', () => {
    render(<Navbar />)
    const toggle = screen.getByRole('button', { name: 'Open workspace sidebar' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('Close workspace sidebar')
  })

  it('announces the engine status politely', () => {
    render(<Navbar />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('connected')
  })

  it('labels the settings action', () => {
    render(<Navbar />)
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
  })
})