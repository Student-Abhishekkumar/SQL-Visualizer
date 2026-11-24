// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EditorLoadingFallback } from './EditorLoadingFallback'

describe('EditorLoadingFallback', () => {
  it('shows a loading message and decorative editor skeletons', () => {
    const { container } = render(<EditorLoadingFallback />)
    expect(screen.getByText('Loading editor…')).toBeInTheDocument()
    expect(container.querySelector('.lazy-fade')).toBeInTheDocument()
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0)
  })
})