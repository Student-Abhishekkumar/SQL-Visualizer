import type { KeyboardEvent, ReactNode } from 'react'

export interface TabDefinition {
  id: string
  label: ReactNode
  /** Optional small indicator (row counts, error dots…). */
  badge?: ReactNode
}

interface TabsProps {
  tabs: TabDefinition[]
  active: string
  onChange: (id: string) => void
  className?: string
  ariaLabel?: string
}

/** Segmented tab strip used by the results panel. */
export function Tabs({
  tabs,
  active,
  onChange,
  className = '',
  ariaLabel = 'Views',
}: TabsProps) {
  const activeIndex = tabs.findIndex((tab) => tab.id === active)

  /** Roving arrow-key navigation, with automatic activation like native tabs. */
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const handledKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!handledKeys.includes(event.key)) return
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    event.preventDefault()
    const buttons = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[next]?.focus()
    const nextTab = tabs[next]
    if (nextTab && nextTab.id !== active) onChange(nextTab.id)
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`flex min-w-0 items-stretch gap-0.5 overflow-x-auto ${className}`}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === active
        // Keep one tab in the tab order even if the active id is stale.
        const isFocusable = isActive || (activeIndex === -1 && index === 0)
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isFocusable ? 0 : -1}
            onKeyDown={(event) => handleKeyDown(event, index)}
            onClick={() => onChange(tab.id)}
            className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent lg:min-h-0 ${
              isActive
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'
            }`}
          >
            {tab.label}
            {tab.badge}
          </button>
        )
      })}
    </div>
  )
}
