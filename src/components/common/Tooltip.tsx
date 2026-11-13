import type { ReactNode } from 'react'

interface TooltipProps {
  label: string
  children: ReactNode
  /** Show the tooltip above (default) or below the target. */
  side?: 'top' | 'bottom'
}

/** Lightweight CSS-only tooltip (no dependency). */
export function Tooltip({ label, children, side = 'bottom' }: TooltipProps) {
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary opacity-0 shadow-panel transition-opacity duration-150 group-hover/tooltip:opacity-100 ${
          side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
        }`}
      >
        {label}
      </span>
    </span>
  )
}
