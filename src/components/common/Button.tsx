import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
  /** Screen-reader announcement while the operation is pending. */
  loadingLabel?: string
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink hover:bg-accent-hover shadow-xs disabled:hover:bg-accent',
  secondary:
    'bg-surface-3 text-text-primary border border-border hover:border-border-strong hover:bg-surface-2',
  ghost:
    'bg-transparent text-text-secondary hover:text-text-primary hover:bg-surface-2',
  danger:
    'bg-transparent text-danger border border-transparent hover:bg-danger-soft hover:border-danger/40',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8.5 px-3 text-[13px] gap-2 rounded-lg',
}

/** The single button primitive used across the whole app. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  loadingLabel = 'Loading',
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
      {loading && <span className="sr-only" role="status">{loadingLabel}</span>}
    </button>
  )
}
