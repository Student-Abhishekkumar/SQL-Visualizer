// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'
import { ErrorState } from './ErrorState'
import { LoadingState } from './LoadingState'
import { Skeleton } from './Skeleton'

describe('feedback state primitives', () => {
  it('keeps decorative skeletons out of the accessibility tree', () => {
    render(<Skeleton data-testid="editor-skeleton" className="h-4 w-32" />)
    expect(screen.getByTestId('editor-skeleton')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('editor-skeleton')).toHaveClass('motion-reduce:animate-none')
  })

  it('announces indeterminate loading politely', () => {
    render(<LoadingState label="Loading editor…" description="Monaco is starting" />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-busy', 'true')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent('Loading editor…')
    expect(status).toHaveTextContent('Monaco is starting')
  })

  it('renders an optional empty-state action', async () => {
    const user = userEvent.setup()
    render(
      <EmptyState
        title="No saved queries"
        description="Save a query to reuse it later."
        action={<button>Create query</button>}
      />,
    )
    expect(screen.getByText('No saved queries')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create query' }))
  })

  it('announces errors and exposes retry recovery', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()
    render(
      <ErrorState
        title="Database unavailable"
        headingLevel={1}
        description="WASM did not initialize."
        onRetry={onRetry}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('WASM did not initialize.')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Database unavailable')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
