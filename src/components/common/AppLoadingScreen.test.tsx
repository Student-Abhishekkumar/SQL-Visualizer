// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppLoadingScreen } from './AppLoadingScreen'

describe('AppLoadingScreen', () => {
  it('announces the startup message and shows an indeterminate progress bar', () => {
    render(<AppLoadingScreen status="initializing" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('SQL Visualizer')

    const progress = screen.getByRole('progressbar', { name: 'Loading SQL Visualizer' })
    expect(progress).toHaveAttribute('aria-valuetext', 'Starting the SQLite engine…')
    expect(screen.getByRole('status')).toHaveTextContent('Starting the SQLite engine…')
  })

  it('shows the preparing message for the uninitialized state', () => {
    render(<AppLoadingScreen status="uninitialized" />)
    expect(screen.getByRole('status')).toHaveTextContent('Preparing your local workspace…')
  })
})