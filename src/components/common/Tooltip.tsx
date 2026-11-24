import {
  cloneElement,
  isValidElement,
  useId,
  type ReactNode,
} from 'react'

interface TooltipProps {
  label: string
  children: ReactNode
  /** Show the tooltip above (default) or below the target. */
  side?: 'top' | 'bottom'
  /**
   * Horizontal alignment to the trigger. `end` keeps tooltips for controls on
   * the right edge inside their container instead of overflowing it.
   */
  align?: 'center' | 'end'
}

/** Dependency-free tooltip available on hover and keyboard focus. */
export function Tooltip({ label, children, side = 'bottom', align = 'center' }: TooltipProps) {
  const tooltipId = useId()
  const trigger = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, {
        'aria-describedby': [children.props['aria-describedby'], tooltipId]
          .filter(Boolean)
          .join(' '),
      })
    : children

  return (
    <span className="group/tooltip relative inline-flex">
      {trigger}
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute z-40 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium whitespace-nowrap text-text-secondary opacity-0 shadow-panel transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 motion-reduce:transition-none ${
          align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'
        } ${side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'}`}
      >
        {label}
      </span>
    </span>
  )
}
