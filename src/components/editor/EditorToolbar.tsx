import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Database,
  Eraser,
  Eye,
  Play,
  RotateCcw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { EXAMPLE_QUERIES } from './exampleQueries'
import { useDatabaseStore } from '../../store/databaseStore'
import {
  EXAMPLE_DATABASE_DESCRIPTION,
  EXAMPLE_DATABASE_NAME,
} from '../../services/database/templates'

interface EditorToolbarProps {
  onRun: () => void
  onFormat: () => void
  onClear: () => void
  onReset: () => Promise<boolean>
  onLoadExample: (sql: string) => void
  onVisualize: () => void
  isRunning: boolean
}

/** Run / format / clear / examples / visualize / reset actions above the editor. */
export function EditorToolbar({
  onRun,
  onFormat,
  onClear,
  onReset,
  onLoadExample,
  onVisualize,
  isRunning,
}: EditorToolbarProps) {
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState({ left: 8, top: 0, width: 320 })
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [exampleError, setExampleError] = useState<string | null>(null)
  const examplesRef = useRef<HTMLDivElement>(null)
  const examplesListRef = useRef<HTMLDivElement>(null)

  const focusExamplesTrigger = () => {
    examplesRef.current?.querySelector('button')?.focus()
  }

  const databases = useDatabaseStore((state) => state.databases)
  const activeDatabaseId = useDatabaseStore((state) => state.activeDatabaseId)
  const createDatabase = useDatabaseStore((state) => state.createDatabase)
  const openDatabase = useDatabaseStore((state) => state.openDatabase)

  const activeDatabase =
    databases.find((database) => database.id === activeDatabaseId) ?? null
  const exampleDatabase =
    databases.find((database) => database.template === 'example') ?? null
  const isExampleDatabase = activeDatabase?.template === 'example'

  useEffect(() => {
    if (!examplesOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!examplesRef.current?.contains(event.target as Node)) {
        setExamplesOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setExamplesOpen(false)
        focusExamplesTrigger()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [examplesOpen])

  const focusOption = (index: number) => {
    const options = examplesListRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    )
    if (options === undefined || options.length === 0) return
    const next = (index + options.length) % options.length
    options[next]?.focus()
  }

  /** Roving arrow-key navigation across the example list. */
  const handleExamplesListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const options = examplesListRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    )
    if (options === undefined || options.length === 0) return
    const current = Array.from(options).indexOf(
      document.activeElement as HTMLButtonElement,
    )
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(current + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(current <= 0 ? options.length - 1 : current - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(options.length - 1)
    }
  }

  const handleReset = async () => {
    setResetting(true)
    setResetError(null)
    try {
      const ok = await onReset()
      if (ok) setResetOpen(false)
    } catch (error) {
      setResetError(error instanceof Error ? error.message : String(error))
    } finally {
      setResetting(false)
    }
  }

  const toggleExamples = () => {
    if (!examplesOpen && examplesRef.current) {
      const rect = examplesRef.current.getBoundingClientRect()
      const width = Math.min(320, window.innerWidth - 16)
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
      const top = rect.bottom + 4
      setDropdownPosition({ left, top, width })
    }
    setExamplesOpen((open) => !open)
  }

  const openExampleDatabase = async () => {
    setExampleError(null)
    try {
      if (exampleDatabase) {
        await openDatabase(exampleDatabase.id)
      } else {
        await createDatabase({
          name: EXAMPLE_DATABASE_NAME,
          description: EXAMPLE_DATABASE_DESCRIPTION,
          template: 'example',
        })
      }
      setExamplesOpen(false)
    } catch (error) {
      setExampleError(error instanceof Error ? error.message : String(error))
    }
  }

  const resetExplanation =
    activeDatabase === null
      ? 'No database is selected.'
      : activeDatabase.template === 'example'
        ? `“${activeDatabase.name}” returns to its original University schema and seed rows.`
        : activeDatabase.template === 'custom'
          ? `“${activeDatabase.name}” runs its setup SQL again from scratch.`
          : `Every table and row in “${activeDatabase.name}” is permanently removed, leaving an empty database.`

  const resetButton = (
    <Button
      variant="danger"
      icon={<RotateCcw className="size-3.5" />}
      onClick={() => setResetOpen(true)}
      aria-label="Reset database"
      title="Reset database"
      className="min-h-11 px-2.5 sm:px-3 lg:min-h-0"
    >
      <span className="hidden sm:inline">Reset DB</span>
    </Button>
  )

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-2 py-1.5 sm:px-3 sm:py-2">
      <div
        role="group"
        aria-label="Query actions"
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        <Button
          variant="primary"
          icon={<Play className="size-3.5 fill-current" />}
          onClick={onRun}
          loading={isRunning}
          className="min-h-11 lg:min-h-0"
        >
          Run
          <kbd className="ml-1 hidden rounded border border-white/25 px-1 text-[10px] font-normal opacity-80 sm:inline">
            Ctrl+Enter
          </kbd>
        </Button>

        <Button
          icon={<Sparkles className="size-3.5" />}
          onClick={onFormat}
          className="min-h-11 lg:min-h-0"
        >
          Format
        </Button>
        <Button
          icon={<Eraser className="size-3.5" />}
          onClick={onClear}
          className="min-h-11 lg:min-h-0"
        >
          Clear
        </Button>
        <Button
          icon={<Eye className="size-3.5" />}
          onClick={onVisualize}
          className="min-h-11 lg:min-h-0"
        >
          Visualize
        </Button>

        {/* Examples dropdown */}
        <div className="relative" ref={examplesRef}>
          <Button
            onClick={toggleExamples}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (!examplesOpen) {
                  toggleExamples()
                  window.requestAnimationFrame(() => focusOption(0))
                } else {
                  focusOption(0)
                }
              }
            }}
            aria-expanded={examplesOpen}
            aria-haspopup="listbox"
            aria-controls={examplesOpen ? 'example-query-listbox' : undefined}
            className={`min-h-11 lg:min-h-0 ${examplesOpen ? 'ring-1 ring-accent/40' : ''}`}
          >
          <Database className="size-3.5" />
          Examples
          <ChevronDown
            className={`size-3 transition-transform ${examplesOpen ? 'rotate-180' : ''}`}
          />
        </Button>
        {examplesOpen && (
          <div
            ref={examplesListRef}
            role="listbox"
            aria-label="Example queries"
            id="example-query-listbox"
            onKeyDown={handleExamplesListKeyDown}
            style={{
              position: 'fixed',
              left: dropdownPosition.left,
              top: dropdownPosition.top,
              width: dropdownPosition.width,
              maxHeight: `min(24rem, calc(100dvh - ${dropdownPosition.top + 8}px))`,
            }}
            className="z-40 overflow-y-auto rounded-lg border border-border bg-surface-2 p-1 shadow-xl"
          >
            {EXAMPLE_QUERIES.map((example) => (
              <button
                key={example.id}
                role="option"
                aria-selected={false}
                onClick={() => {
                  onLoadExample(example.sql)
                  setExamplesOpen(false)
                }}
                className="block min-h-11 w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] font-medium text-text-primary">
                    {example.title}
                  </div>
                  {example.visualizable === true && (
                    <span className="shrink-0 rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent">
                      visualizable
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-text-muted">
                  {example.description}
                </div>
              </button>
            ))}
            {!isExampleDatabase && (
              <div className="mt-1 rounded-md border border-border bg-surface px-2.5 py-2">
                <p className="text-[10px] leading-relaxed text-text-muted">
                  These examples query the optional Example Database. On another
                  database, create matching tables first.
                </p>
                <button
                  type="button"
                  onClick={() => void openExampleDatabase()}
                  className="mt-1 inline-flex items-center gap-1 rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent transition-colors hover:bg-accent/15"
                >
                  <Database className="size-3" aria-hidden />
                  {exampleDatabase ? 'Open Example Database' : 'Create Example Database'}
                </button>
                {exampleError && (
                  <p className="mt-1 text-[10px] text-danger">{exampleError}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

        <div className="sm:hidden">{resetButton}</div>
      </div>

      <div className="ml-auto max-sm:hidden">{resetButton}</div>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset database"
      >
        <p className="text-sm leading-relaxed text-text-secondary">
          {resetExplanation} Resetting is permanent and cannot be undone.
        </p>
        {resetError && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{resetError}</span>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setResetOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={resetting}
            onClick={handleReset}
            className="!bg-danger hover:!bg-danger/85"
          >
            Reset database
          </Button>
        </div>
      </Modal>
    </div>
  )
}
