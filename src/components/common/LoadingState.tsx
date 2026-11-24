import { Loader2 } from 'lucide-react'
import type { HTMLAttributes } from 'react'

interface LoadingStateProps extends HTMLAttributes<HTMLDivElement> {
  label: string
  description?: string
  size?: 'sm' | 'md'
}

/** Indeterminate, screen-reader-announced progress for a local operation. */
export function LoadingState({
  label,
  description,
  size = 'md',
  className = '',
  ...rest
}: LoadingStateProps) {
  return (
    <div
      {...rest}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      className={`inline-flex items-center justify-center gap-2 text-text-muted ${className}`}
    >
      <Loader2
        className={`${size === 'sm' ? 'size-3.5' : 'size-4'} shrink-0 animate-spin text-accent motion-reduce:animate-none`}
        aria-hidden="true"
      />
      <span className={size === 'sm' ? 'text-xs' : 'text-sm'}>{label}</span>
      {description !== undefined && (
        <span className="text-xs text-text-muted">{description}</span>
      )}
    </div>
  )
}
