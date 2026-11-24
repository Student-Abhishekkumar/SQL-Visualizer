import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Database,
  Plus,
  Settings2,
  Table2,
} from 'lucide-react'
import { useDatabaseStore } from '../../store/databaseStore'
import { useUIStore } from '../../store/uiStore'
import { tableSummary } from './format'

/**
 * Top-bar database selector: shows the active database and offers a
 * fast switch list plus an entry point to the full Database Manager.
 */
export function DatabaseSelector() {
  const databases = useDatabaseStore((state) => state.databases)
  const activeDatabaseId = useDatabaseStore((state) => state.activeDatabaseId)
  const openDatabase = useDatabaseStore((state) => state.openDatabase)
  const openDatabaseManager = useUIStore((state) => state.openDatabaseManager)
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const active = databases.find((database) => database.id === activeDatabaseId) ?? null

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const switchTo = async (id: string) => {
    if (id === activeDatabaseId) {
      setOpen(false)
      return
    }
    setBusyId(id)
    setError(null)
    try {
      await openDatabase(id)
      setOpen(false)
    } catch (switchError) {
      setError(
        switchError instanceof Error ? switchError.message : 'Could not open that database.',
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="relative w-full min-w-0 sm:w-auto" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select database"
        className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-left transition-colors hover:border-control-border sm:min-h-0 sm:max-w-[260px] sm:py-1.5"
      >
        <Database className="size-3.5 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-text-primary">
            {active?.name ?? (databases.length === 0 ? 'No database' : 'Select database')}
          </span>
          <span className="hidden truncate text-[10px] text-text-muted sm:block">
            {active ? tableSummary(active) : 'Create or open a workspace'}
          </span>
        </span>
        <ChevronDown
          className={`size-3 shrink-0 text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <div className="fixed inset-x-2 top-15 z-50 mt-1 overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-window sm:absolute sm:inset-auto sm:left-0 sm:top-full sm:w-80 sm:max-w-[calc(100vw-2rem)]">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
              Databases
            </span>
            <span className="text-[10px] text-text-muted">{databases.length}</span>
          </div>

          <div
            role="listbox"
            aria-label="Databases"
            className="max-h-64 overflow-y-auto p-1"
          >
            {databases.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-muted">
                No databases yet. Create one to start.
              </p>
            ) : (
              databases.map((database) => {
                const isActive = database.id === activeDatabaseId
                return (
                  <button
                    key={database.id}
                    role="option"
                    aria-selected={isActive}
                    disabled={busyId !== null}
                    onClick={() => void switchTo(database.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                      isActive ? 'bg-accent-soft' : 'hover:bg-surface-2'
                    } ${busyId !== null && !isActive ? 'opacity-60' : ''}`}
                  >
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded ${
                        isActive ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-text-muted'
                      }`}
                      aria-hidden
                    >
                      {isActive ? <Check className="size-3" /> : <Table2 className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-text-primary">
                        {database.name}
                      </span>
                      <span className="block truncate text-[10px] text-text-muted">
                        {busyId === database.id ? 'Opening…' : tableSummary(database)}
                      </span>
                    </span>
                    {isActive && (
                      <span className="shrink-0 rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent">
                        Active
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>

          {error && (
            <p className="border-t border-border px-3 py-2 text-[11px] text-danger">
              {error}
            </p>
          )}

          <div className="flex items-center gap-1 border-t border-border p-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openDatabaseManager('manage')
              }}
              className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Settings2 className="size-3.5" aria-hidden />
              Manage databases
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                openDatabaseManager('create')
              }}
              aria-label="Create database"
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent-soft"
            >
              <Plus className="size-3.5" aria-hidden />
              New
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
