// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppLoadingScreen } from './AppLoadingScreen'

describe('AppLoadingScreen', () => {
  it('renders the living canvas, the real status and no fake progress', () => {
    render(<AppLoadingScreen status="initializing" />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('SQL Visualizer')
    expect(screen.getByRole('status')).toHaveTextContent('Starting the SQLite engine…')
    expect(screen.queryByRole('progressbar')).toBeNull()

    const loader = document.querySelector('.app-loader')
    expect(loader).toHaveAttribute('aria-busy', 'true')
    expect(document.querySelectorAll('.cl-node').length).toBeGreaterThan(4)
    expect(document.querySelectorAll('.cl-edge').length).toBeGreaterThan(3)
    expect(document.querySelectorAll('.cl-socket').length).toBeGreaterThan(3)
  })

  it('shows the preparing message for the uninitialized state', () => {
    render(<AppLoadingScreen status="uninitialized" />)
    expect(screen.getByRole('status')).toHaveTextContent('Preparing your local workspace…')
  })
})