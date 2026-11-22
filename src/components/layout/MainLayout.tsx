import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Database, Plus } from 'lucide-react'
import { Navbar } from './Navbar'
import { Sidebar } from './Sidebar'
import { WorkspaceViewToggle } from './WorkspaceViewToggle'
import { SQLEditor } from '../editor/SQLEditor'
import { EditorToolbar } from '../editor/EditorToolbar'
import { ResultsPanel } from '../results/ResultsPanel'
import { useEditorStore } from '../../store/editorStore'
import { useDatabaseStore } from '../../store/databaseStore'
import { useUIStore } from '../../store/uiStore'
import { useVisualizationStore } from '../../store/visualizationStore'
import { useSQLExecution } from '../../hooks/useSQLExecution'
import { formatSQL } from '../../services/sql/sqlFormatter'
import { splitStatements } from '../../utils/queryHelpers'

const MIN_SPLIT = 20
const MAX_SPLIT = 80

/**
 * The Canvas workspace is a secondary feature and brings the animation
 * and flow-rendering code with it. It is loaded the first time Canvas is
 * opened, then kept mounted so pan/zoom, selection and playback survive
 * later switches.
 */
const VisualizationWorkspace = lazy(() =>
  import('../visualization/VisualizationWorkspace').then((module) => ({
    default: module.VisualizationWorkspace,
  })),
)

/**
 * Main workspace shell.
 *
 * Two workspaces share one execution context:
 *  - Query  : SQL editor + results
 *  - Canvas : full-size animated SQL visualization
 *
 * Both stay mounted while hidden, so switching never resets editor
 * content, results, canvas pan/zoom, node selection, playback or the
 * active database. Ctrl/Cmd+Shift+M toggles the visible workspace.
 */
export function MainLayout() {
  const content = useEditorStore((state) => state.content)
  const setContent = useEditorStore((state) => state.setContent)
  const loadQuery = useEditorStore((state) => state.loadQuery)
  const clear = useEditorStore((state) => state.clear)
  const isExecuting = useDatabaseStore((state) => state.isExecuting)
  const lastResult = useDatabaseStore((state) => state.lastResult)
  const activeDatabaseId = useDatabaseStore((state) => state.activeDatabaseId)
  const databases = useDatabaseStore((state) => state.databases)
  const reset = useDatabaseStore((state) => state.resetDatabase)
  const visualize = useVisualizationStore((state) => state.visualize)
  const workspaceView = useUIStore((state) => state.workspaceView)
  const setWorkspaceView = useUIStore((state) => state.setWorkspaceView)
  const toggleWorkspaceView = useUIStore((state) => state.toggleWorkspaceView)
  const setDatabaseManagerOpen = useUIStore((state) => state.setDatabaseManagerOpen)
  const { execute } = useSQLExecution()

  const [editorRatio, setEditorRatio] = useState(52)
  const [canvasMounted, setCanvasMounted] = useState(false)
  const mainRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const activeDatabase = databases.find((database) => database.id === activeDatabaseId) ?? null

  // Ctrl/Cmd+Shift+M toggles Query/Canvas. Chosen because Monaco does not
  // bind it, so the shortcut is safe even while the editor is focused.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        toggleWorkspaceView()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleWorkspaceView])

  const runQuery = useCallback(() => {
    void execute(content)
  }, [execute, content])

  const handleVisualize = useCallback(() => {
    visualize(content, splitStatements(content))
    setWorkspaceView('canvas')
  }, [visualize, content, setWorkspaceView])

  const handleReset = useCallback(async () => {
    try {
      await reset()
      return true
    } catch {
      return false
    }
  }, [reset])

  const startDrag = (event: React.PointerEvent) => {
    draggingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDrag = (event: React.PointerEvent) => {
    if (!draggingRef.current || !mainRef.current) return
    const bounds = mainRef.current.getBoundingClientRect()
    if (bounds.height === 0) return
    const ratio = ((event.clientY - bounds.top) / bounds.height) * 100
    setEditorRatio(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio)))
  }

  const endDrag = (event: React.PointerEvent) => {
    draggingRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const queryVisible = workspaceView === 'query'
  const canvasVisible = workspaceView === 'canvas'

  // Mount the Canvas workspace on first visit and leave it mounted. This is
  // a render-phase adjustment (not an effect) so the lazy chunk starts on
  // the same render that reveals Canvas.
  if (canvasVisible && !canvasMounted) setCanvasMounted(true)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text-primary">
      <Navbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <WorkspaceViewToggle />

          {activeDatabaseId === null && (
            <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              <Database className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">
                No database is selected. Create or open one to run SQL.
              </span>
              <button
                type="button"
                onClick={() => setDatabaseManagerOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-warning/40 px-2 py-1 text-[11px] font-medium transition-colors hover:bg-warning/15"
              >
                <Plus className="size-3" aria-hidden />
                Open Database Manager
              </button>
            </div>
          )}

          <div ref={mainRef} className="relative min-h-0 flex-1 overflow-hidden">
            {/* Query workspace — kept mounted so editor/results state survives. */}
            <div
              aria-hidden={!queryVisible}
              className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden transition-opacity duration-200 ${
                queryVisible ? 'opacity-100' : 'pointer-events-none invisible opacity-0'
              }`}
            >
              <div
                className="flex min-h-0 flex-col overflow-hidden"
                style={{ height: `${editorRatio}%` }}
              >
                <EditorToolbar
                  onRun={runQuery}
                  onFormat={() => setContent(formatSQL(content))}
                  onClear={clear}
                  onReset={handleReset}
                  onLoadExample={loadQuery}
                  onVisualize={handleVisualize}
                  isRunning={isExecuting}
                />
                <div className="min-h-0 flex-1 overflow-hidden">
                  <SQLEditor value={content} onChange={setContent} onRun={runQuery} />
                </div>
              </div>

              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize editor and results"
                onPointerDown={startDrag}
                onPointerMove={onDrag}
                onPointerUp={endDrag}
                className="group h-1.5 shrink-0 cursor-row-resize touch-none bg-bg transition-colors hover:bg-accent/50"
              >
                <div className="mx-auto h-full w-10 rounded-full" />
              </div>

              <div className="min-h-0 flex-1 overflow-hidden">
                <ResultsPanel result={lastResult} isExecuting={isExecuting} />
              </div>
            </div>

            {/* Canvas workspace — also kept mounted for pan/zoom/playback. */}
            <div
              aria-hidden={!canvasVisible}
              className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-surface transition-opacity duration-200 ${
                canvasVisible ? 'opacity-100' : 'pointer-events-none invisible opacity-0'
              }`}
            >
              {canvasMounted && (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-text-muted">
                      Loading visualization…
                    </div>
                  }
                >
                  <VisualizationWorkspace
                    queryName={
                      content.trim() === ''
                        ? '(empty query)'
                        : (content.trim().split('\n')[0] ?? '')
                    }
                    activeDatabaseName={activeDatabase?.name ?? null}
                    currentQuery={content}
                    onRevisualize={handleVisualize}
                    onClose={() => setWorkspaceView('query')}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
