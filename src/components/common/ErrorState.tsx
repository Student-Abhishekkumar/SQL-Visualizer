import { RotateCcw, TriangleAlert } from 'lucide-react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Button } from './Button'

interface ErrorStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  headingLevel?: 1 | 2 | 3
  description?: ReactNode
  icon?: ReactNode
  onRetry?: () => void
  retryLabel?: string
}

/** Local error presentation with an optional, explicit recovery action. */
export function ErrorState({
  title,
  headingLevel = 2,
  description,
  icon,
  onRetry,
  retryLabel = 'Retry',
  className = '',
  ...rest
}: ErrorStateProps) {
  const Heading = headingLevel === 1 ? 'h1' : headingLevel === 2 ? 'h2' : 'h3'
  return (
    <div
      {...rest}
      role="alert"
      className={`flex h-full flex-col items-center justify-center gap-4 p-6 text-center ${className}`}
    >
      <div
        className="flex size-11 items-center justify-center rounded-xl bg-danger-soft text-danger"
        aria-hidden="true"
      >
        {icon ?? <TriangleAlert className="size-5" />}
      </div>
      <div>
        <Heading className="text-base font-semibold text-text-primary">{title}</Heading>
        {description !== undefined && (
          <div className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-text-secondary">
            {description}
          </div>
        )}
      </div>
      {onRetry !== undefined && (
        <Button
          type="button"
          variant="primary"
          icon={<RotateCcw className="size-3.5" aria-hidden="true" />}
          onClick={onRetry}
        >
          {retryLabel}
        </Button>
      )}
    </div>
  )
}
