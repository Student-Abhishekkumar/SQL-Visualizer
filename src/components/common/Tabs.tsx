import type { ReactNode } from 'react'

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
}

/** Segmented tab strip used by the results panel. */
export function Tabs({ tabs, active, onChange, className = '' }: TabsProps) {
  return (
    <div
      role="tablist"
      className={`flex items-stretch gap-0.5 ${className}`}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-accent ${
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
