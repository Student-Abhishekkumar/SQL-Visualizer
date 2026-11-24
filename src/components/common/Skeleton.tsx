import type { HTMLAttributes } from 'react'

type SkeletonProps = HTMLAttributes<HTMLDivElement>

/**
 * Non-semantic placeholder for a known content shape. Compose several
 * skeletons to mirror the final layout without announcing fake content.
 */
export function Skeleton({ className = '', ...rest }: SkeletonProps) {
  return (
    <div
      {...rest}
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-surface-3/80 motion-reduce:animate-none ${className}`}
    />
  )
}
