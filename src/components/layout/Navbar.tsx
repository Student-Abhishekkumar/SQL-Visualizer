import { useEffect } from 'react'
import { Database, Moon, PanelLeft, Settings, Sun } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useDatabaseStore } from '../../store/databaseStore'
import { Tooltip } from '../common/Tooltip'
import { SettingsModal } from './SettingsModal'

/** Top navigation: brand, database indicator, theme, settings. */
export function Navbar() {
  const toggleTheme = useUIStore((state) => state.toggleTheme)
  const theme = useUIStore((state) => state.theme)
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen)
  const isSettingsOpen = useUIStore((state) => state.isSettingsOpen)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)
  const schema = useDatabaseStore((state) => state.schema)
  const status = useDatabaseStore((state) => state.status)

  useEffect(() => {
    // Title already set in index.html; keep favicon logic minimal.
  }, [])

  const statusLabel =
    status === 'ready' ? 'SQLite WASM · connected' : `SQLite WASM · ${status}`

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-elevated px-3">
      <button
        onClick={toggleSidebar}
        aria-label="Toggle sidebar"
        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary md:hidden"
      >
        <PanelLeft className="size-4" />
      </button>

      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-purple text-white shadow-sm">
          <Database className="size-4" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-text-primary">
          SQL Visualizer
        </span>
        <span className="hidden rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-muted sm:inline">
          Stage 1 · Playground
        </span>
      </div>

      <div className="mx-auto hidden items-center gap-2 md:flex">
        <span className="flex items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1 text-[12px]">
          <span
            className={`size-1.5 rounded-full ${
              status === 'ready'
                ? 'bg-success'
                : status === 'error'
                  ? 'bg-danger'
                  : 'bg-warning animate-pulse'
            }`}
          />
          <span className="font-medium text-text-secondary">
            {schema?.name ?? 'University Database'}
          </span>
          <span className="text-text-muted">·</span>
          <span className="text-text-muted">{statusLabel}</span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1 md:ml-0">
        <Tooltip label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <button
            onClick={toggleTheme}
            aria-label="Toggle color theme"
            className="rounded-md p-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </Tooltip>
        <Tooltip label="Settings">
          <button
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            className="rounded-md p-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            <Settings className="size-4" />
          </button>
        </Tooltip>
      </div>

      <SettingsModal open={isSettingsOpen} />
    </header>
  )
}
