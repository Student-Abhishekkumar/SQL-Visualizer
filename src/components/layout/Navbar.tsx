import { Database, PanelLeft, Settings } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useDatabaseStore } from '../../store/databaseStore'
import type { DatabaseStatus } from '../../types/database'
import { Tooltip } from '../common/Tooltip'
import { SettingsModal } from './SettingsModal'
import { ThemeMenu } from './ThemeMenu'
import { DatabaseSelector } from '../database/DatabaseSelector'
import { DatabaseManager } from '../database/DatabaseManager'

const ICON_BUTTON_CLASS =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none sm:size-9'

/** How each engine lifecycle state reads in the top bar. */
const STATUS_PRESENTATION: Record<
  DatabaseStatus,
  { label: string; dot: string; text: string }
> = {
  ready: { label: 'connected', dot: 'bg-success', text: 'text-success' },
  initializing: {
    label: 'starting',
    dot: 'bg-warning motion-safe:animate-pulse',
    text: 'text-warning',
  },
  uninitialized: { label: 'offline', dot: 'bg-text-muted', text: 'text-text-muted' },
  error: { label: 'error', dot: 'bg-danger', text: 'text-danger' },
}

/**
 * Application top navigation.
 *
 * Three zones share one 56px bar: identity (brand + sidebar toggle),
 * context (active database + engine status) and actions (theme, settings).
 * The brand collapses to its mark on narrow screens and the engine status
 * collapses to a dot, so controls never overlap. Tooltips and explicit
 * labels keep every icon button usable from the keyboard.
 */
export function Navbar() {
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen)
  const isSettingsOpen = useUIStore((state) => state.isSettingsOpen)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen)
  const status = useDatabaseStore((state) => state.status)

  const statusPresentation = STATUS_PRESENTATION[status]

  return (
    <header
      id="app-navbar"
      className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-bg-elevated px-2 sm:gap-3 sm:px-3"
    >
      {/* Identity + compact-screen navigation. */}
      <div className="flex min-w-0 shrink-0 items-center gap-2 sm:gap-2.5">
        <Tooltip label={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}>
          <button
            id="sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={isSidebarOpen ? 'Close workspace sidebar' : 'Open workspace sidebar'}
            aria-controls="workspace-sidebar"
            aria-expanded={isSidebarOpen}
            className={`${ICON_BUTTON_CLASS} lg:hidden`}
          >
            <PanelLeft className="size-4" aria-hidden="true" />
          </button>
        </Tooltip>

        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-accent via-violet to-cyan text-accent-ink shadow-xs ring-1 ring-white/20 ring-inset">
            <span
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-b from-white/25 via-transparent to-transparent"
            />
            <Database className="relative size-4" aria-hidden="true" />
          </span>
          <span className="hidden min-w-0 sm:block">
            <span className="block truncate text-[13px] leading-tight font-semibold tracking-tight text-text-primary">
              SQL Visualizer
            </span>
            <span className="mt-0.5 hidden text-[9px] leading-none font-medium tracking-[0.16em] text-text-muted uppercase xl:block">
              Local SQL workspace
            </span>
          </span>
        </div>
      </div>

      {/* Context: active database and engine state. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <DatabaseSelector />
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="hidden shrink-0 items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1 md:inline-flex"
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${statusPresentation.dot}`}
          />
          <span className="font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase">
            <span className="text-text-muted">SQLite WASM</span>
            <span className={statusPresentation.text}> · {statusPresentation.label}</span>
          </span>
        </span>
      </div>

      {/* Actions. */}
      <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
        <ThemeMenu />
        <Tooltip label="Settings">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            className={ICON_BUTTON_CLASS}
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {/* Accent hairline: a quiet developer-tool signature. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-accent/50 via-violet/40 to-cyan/50"
      />

      <SettingsModal open={isSettingsOpen} />
      <DatabaseManager />
    </header>
  )
}