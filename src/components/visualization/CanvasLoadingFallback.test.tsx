// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasLoadingFallback } from './CanvasLoadingFallback'

describe('CanvasLoadingFallback', () => {
  it('renders a canvas-shaped skeleton without announcing content', () => {
    const { container } = render(<CanvasLoadingFallback />)
    expect(container.querySelector('.lazy-fade')).toBeInTheDocument()
    expect(
      container.querySelectorAll('[aria-hidden="true"]').length,
    ).toBeGreaterThanOrEqual(6)
  })
})