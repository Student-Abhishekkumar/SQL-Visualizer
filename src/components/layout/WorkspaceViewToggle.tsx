import { useRef, type KeyboardEvent } from 'react'
import { Code2, Workflow } from 'lucide-react'
import { useUIStore, type WorkspaceView } from '../../store/uiStore'

const VIEWS: Array<{
  id: WorkspaceView
  label: string
  hint: string
  icon: typeof Code2
}> = [
  {
    id: 'query',
    label: 'Query',
    hint: 'SQL editor and results',
    icon: Code2,
  },
  {
    id: 'canvas',
    label: 'Canvas',
    hint: 'Animated SQL data-flow visualization',
    icon: Workflow,
  },
]

const TAB_BASE_CLASS =
  'relative inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none sm:min-h-8'

/** Keyboard-accessible Query / Canvas switch; both workspaces stay mounted. */
export function WorkspaceViewToggle() {
  const workspaceView = useUIStore((state) => state.workspaceView)
  const setWorkspaceView = useUIStore((state) => state.setWorkspaceView)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % VIEWS.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + VIEWS.length) % VIEWS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = VIEWS.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    const nextView = VIEWS[nextIndex]
    if (nextView === undefined) return
    setWorkspaceView(nextView.id)
    tabRefs.current[nextIndex]?.focus({ preventScroll: true })
  }

  return (
    <nav
      aria-label="Workspace"
      className="flex min-h-11 shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-surface px-2 py-1.5 sm:gap-3 sm:px-3"
    >
      <div
        role="tablist"
        aria-label="Workspace view"
        aria-orientation="horizontal"
        className="flex shrink-0 rounded-lg border border-border bg-surface-2 p-0.5 shadow-xs"
      >
        {VIEWS.map((view, index) => {
          const Icon = view.icon
          const active = workspaceView === view.id
          return (
            <button
              key={view.id}
              ref={(element) => {
                tabRefs.current[index] = element
              }}
              id={`workspace-tab-${view.id}`}
              role="tab"
              type="button"
              aria-selected={active}
              aria-controls={`workspace-panel-${view.id}`}
              tabIndex={active ? 0 : -1}
              title={view.hint}
              onClick={() => setWorkspaceView(view.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={`${TAB_BASE_CLASS} ${
                active
                  ? 'bg-accent text-accent-ink shadow-xs'
                  : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
              }`}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span>{view.label}</span>
              {/* Persistent indicator slot: no layout shift when the view changes. */}
              <span
                aria-hidden="true"
                className={`ml-0.5 size-1.5 shrink-0 rounded-full transition-opacity duration-200 motion-reduce:transition-none ${
                  active ? 'bg-accent-ink/80 opacity-100' : 'opacity-0'
                }`}
              />
            </button>
          )
        })}
      </div>

      <span className="hidden min-w-0 truncate text-[11px] text-text-muted md:inline">
        {workspaceView === 'query'
          ? 'Write and run SQL against the active database.'
          : 'Stage-by-stage animation of the last visualized query.'}
      </span>

      <span className="ml-auto hidden shrink-0 items-center gap-1 text-[10px] text-text-muted lg:flex">
        <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5 font-mono">Ctrl</kbd>
        <span>+</span>
        <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5 font-mono">
          Shift
        </kbd>
        <span>+</span>
        <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5 font-mono">M</kbd>
      </span>
    </nav>
  )
}