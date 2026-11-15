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

/**
 * Always-visible Query / Canvas switch.
 *
 * Both workspaces stay mounted; this control only changes which one is
 * visible, so editor state, results, canvas pan/zoom, selection and
 * playback are preserved. Ctrl/Cmd+Shift+M toggles it as well.
 */
export function WorkspaceViewToggle() {
  const workspaceView = useUIStore((state) => state.workspaceView)
  const setWorkspaceView = useUIStore((state) => state.setWorkspaceView)

  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-surface px-3 py-1.5">
      <div
        role="tablist"
        aria-label="Workspace view"
        className="flex shrink-0 rounded-lg border border-border bg-surface-2 p-0.5"
      >
        {VIEWS.map((view) => {
          const Icon = view.icon
          const active = workspaceView === view.id
          return (
            <button
              key={view.id}
              role="tab"
              type="button"
              aria-selected={active}
              title={view.hint}
              onClick={() => setWorkspaceView(view.id)}
              className={`relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-accent ${
                active
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
              }`}
            >
              <Icon className="size-3.5" aria-hidden />
              {view.label}
            </button>
          )
        })}
      </div>

      <span className="hidden truncate text-[11px] text-text-muted sm:inline">
        {workspaceView === 'query'
          ? 'Write and run SQL against the active database.'
          : 'Stage-by-stage animation of the last visualized query.'}
      </span>

      <span className="ml-auto hidden shrink-0 items-center gap-1 text-[10px] text-text-muted lg:flex">
        <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5 font-sans">
          Ctrl
        </kbd>
        <span>+</span>
        <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5 font-sans">
          Shift
        </kbd>
        <span>+</span>
        <kbd className="rounded border border-border bg-surface-2 px-1 py-0.5 font-sans">
          M
        </kbd>
      </span>
    </div>
  )
}
