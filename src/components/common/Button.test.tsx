// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('exposes pending state without changing the visible label', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <Button loading loadingLabel="Running query" onClick={onClick}>
        Run
      </Button>,
    )

    const button = screen.getByRole('button', { name: /Run/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Running query')
    expect(button).toHaveTextContent('Run')
    await user.click(button)
    expect(onClick).not.toHaveBeenCalled()

    rerender(<Button onClick={onClick}>Run</Button>)
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('uses theme-aware ink and the shared focus-ring token', () => {
    render(<Button variant="primary">Visualize</Button>)
    const button = screen.getByRole('button', { name: 'Visualize' })
    expect(button).toHaveClass('text-accent-ink')
    expect(button).toHaveClass('focus-visible:outline-focus-ring')
    expect(button).toHaveClass('motion-reduce:transition-none')
  })
})
