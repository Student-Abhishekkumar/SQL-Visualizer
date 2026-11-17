import { useEffect, useRef } from 'react'
import { BookOpen, X } from 'lucide-react'
import { Tooltip } from '../common/Tooltip'
import type { StageSnapshot, VisualizedStage } from '../../types/visualization'
import { ExplanationPanel } from './ExplanationPanel'

/**
 * Independently togglable documentation sidebar.
 *
 * On wide workspaces it is a real flex column, so opening/closing it
 * gives the canvas the released width. On narrow containers it becomes
 * an overlay instead of squeezing the canvas. The panel stays mounted
 * while closed (only width/transform/opacity change), which preserves
 * its scroll position, the selected learning level and the knowledge
 * check answer for the lifetime of the session.
 */

interface DocumentationSidebarProps {
  open: boolean
  stage: VisualizedStage | null
  snapshot: StageSnapshot | null
  onClose: () => void
}

export function DocumentationSidebar({
  open,
  stage,
  snapshot,
  onClose,
}: DocumentationSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(open)

  // Keep keyboard focus sensible across the closed/open transition:
  // - closing while focus is inside moves it back to the header toggle;
  // - opening from the unmounted edge tab moves focus into the panel.
  useEffect(() => {
    const previous = wasOpenRef.current
    wasOpenRef.current = open
    if (!open) {
      if (sidebarRef.current?.contains(document.activeElement)) {
        document.getElementById('documentation-toggle')?.focus()
      }
      return
    }
    if (!previous && document.activeElement === document.body) {
      closeRef.current?.focus()
    }
  }, [open])

  return (
    <aside
      ref={sidebarRef}
      id="documentation-sidebar"
      data-testid="documentation-sidebar"
      data-state={open ? 'open' : 'closed'}
      aria-label="Documentation"
      aria-hidden={open ? undefined : true}
      inert={!open}
      style={{ width: open ? undefined : 0 }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onClose()
      }}
      className="docs-sidebar flex min-w-0 shrink-0 flex-col overflow-clip border-border bg-surface"
    >
      <div className="flex h-full w-full min-w-0 shrink-0 flex-col">
        <header className="flex min-w-0 shrink-0 items-start gap-2 border-b border-border bg-surface-2 px-3.5 py-2.5">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-accent-soft text-accent">
            <BookOpen className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold tracking-tight text-text-primary">
              Documentation
            </h2>
            <p className="mt-0.5 truncate text-[10px] text-text-muted">
              Stage guide &amp; SQLite references
            </p>
          </div>
          <Tooltip label="Close documentation sidebar">
            <button
              ref={closeRef}
              type="button"
              aria-label="Close documentation sidebar"
              onClick={onClose}
              className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </Tooltip>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ExplanationPanel stage={stage} snapshot={snapshot} />
        </div>
      </div>
    </aside>
  )
}

/** Compact edge tab that keeps the sidebar reachable while it is closed. */
export function DocumentationEdgeTab({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="absolute top-1/2 right-0 z-30 -translate-y-1/2">
      <Tooltip label="Show documentation" side="top">
        <button
          type="button"
          aria-label="Open documentation sidebar"
          onClick={onOpen}
          className="inline-flex h-10 w-7 items-center justify-center rounded-l-lg border border-r-0 border-border bg-surface/95 text-text-muted shadow-panel backdrop-blur-sm transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
        >
          <BookOpen className="size-3.5" aria-hidden />
        </button>
      </Tooltip>
    </div>
  )
}
