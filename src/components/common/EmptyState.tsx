import type { HTMLAttributes, ReactNode } from 'react'

interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  action?: ReactNode
}

/** Consistent empty content with an optional next action. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className = '',
  ...rest
}: EmptyStateProps) {
  return (
    <div
      {...rest}
      className={`flex h-full flex-col items-center justify-center gap-2 p-8 text-center ${className}`}
    >
      {icon !== undefined && (
        <div className="text-text-muted/60" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="text-sm font-medium text-text-secondary">{title}</div>
      {description !== undefined && (
        <div className="max-w-sm text-xs leading-relaxed text-text-muted">{description}</div>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  )
}
