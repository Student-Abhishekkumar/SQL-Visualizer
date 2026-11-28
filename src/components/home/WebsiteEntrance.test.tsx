// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WebsiteEntrance } from './WebsiteEntrance'

afterEach(() => {
  cleanup()
})

describe('WebsiteEntrance', () => {
  it('renders a large Canvas composition with branding', () => {
    render(<WebsiteEntrance />)

    expect(document.querySelectorAll('.cl-node').length).toBeGreaterThan(4)
    expect(document.querySelectorAll('.cl-edge').length).toBeGreaterThan(3)
    expect(document.querySelectorAll('.cl-socket').length).toBeGreaterThan(3)
    expect(screen.getByText('SQL Visualizer')).toBeInTheDocument()
    expect(document.querySelector('.website-entrance')).toHaveAttribute('aria-hidden', 'true')
  })
})