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
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [exampleError, setExampleError] = useState<string | null>(null)
  const examplesRef = useRef<HTMLDivElement>(null)

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
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [examplesOpen])

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

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2">
      <Button
        variant="primary"
        icon={<Play className="size-3.5 fill-current" />}
        onClick={onRun}
        loading={isRunning}
      >
        Run
        <kbd className="ml-1 hidden rounded border border-white/25 px-1 text-[10px] font-normal opacity-80 sm:inline">
          Ctrl+Enter
        </kbd>
      </Button>

      <Button icon={<Sparkles className="size-3.5" />} onClick={onFormat}>
        Format
      </Button>
      <Button icon={<Eraser className="size-3.5" />} onClick={onClear}>
        Clear
      </Button>
      <Button icon={<Eye className="size-3.5" />} onClick={onVisualize}>
        Visualize
      </Button>

      {/* Examples dropdown */}
      <div className="relative" ref={examplesRef}>
        <Button
          onClick={() => setExamplesOpen((open) => !open)}
          aria-expanded={examplesOpen}
          aria-haspopup="listbox"
        >
          <Database className="size-3.5" />
          Examples
          <ChevronDown
            className={`size-3 transition-transform ${examplesOpen ? 'rotate-180' : ''}`}
          />
        </Button>
        {examplesOpen && (
          <div
            role="listbox"
            aria-label="Example queries"
            className="absolute left-0 top-full z-30 mt-1 max-h-96 w-80 overflow-y-auto rounded-lg border border-border bg-surface-2 p-1 shadow-xl"
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
                className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-3"
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

      <div className="flex-1" />

      <Button
        variant="danger"
        icon={<RotateCcw className="size-3.5" />}
        onClick={() => setResetOpen(true)}
      >
        Reset DB
      </Button>

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
