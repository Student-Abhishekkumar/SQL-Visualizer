import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Database, Plus } from 'lucide-react'
import { CanvasLoadingFallback } from '../visualization/CanvasLoadingFallback'
import { Navbar } from './Navbar'
import { Sidebar } from './Sidebar'
import { WorkspaceViewToggle } from './WorkspaceViewToggle'
import { EditorResultsSeparator } from './EditorResultsSeparator'
import { SQLEditor } from '../editor/SQLEditor'
import { EditorToolbar } from '../editor/EditorToolbar'
import { ResultsPanel } from '../results/ResultsPanel'
import { useEditorStore } from '../../store/editorStore'
import { useDatabaseStore } from '../../store/databaseStore'
import { useUIStore } from '../../store/uiStore'
import { useSQLExecution } from '../../hooks/useSQLExecution'
import { splitStatements } from '../../utils/queryHelpers'
import { formatSQL } from '../../services/sql/sqlFormatter'

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
  const workspaceView = useUIStore((state) => state.workspaceView)
  const setWorkspaceView = useUIStore((state) => state.setWorkspaceView)
  const toggleWorkspaceView = useUIStore((state) => state.toggleWorkspaceView)
  const setDatabaseManagerOpen = useUIStore((state) => state.setDatabaseManagerOpen)
  const { execute } = useSQLExecution()

  const [editorRatio, setEditorRatio] = useState(52)
  const [canvasMounted, setCanvasMounted] = useState(false)
  const mainRef = useRef<HTMLDivElement>(null)

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

  // Visualization is heavy and on demand: the store (and the whole
  // simulation engine behind it) loads only when the user asks for it.
  const handleVisualize = useCallback(() => {
    const query = content
    // Mount the workspace first so its lazy chunk starts downloading while
    // the store module resolves.
    setWorkspaceView('canvas')
    void import('../../store/visualizationStore').then(({ useVisualizationStore }) => {
      useVisualizationStore.getState().visualize(query, splitStatements(query))
    })
  }, [content, setWorkspaceView])

  // The formatter is tiny and already part of the workspace graph (the
  // history and messages panels summarize through it), so a dynamic import
  // could never split it out — it only delayed the click by a microtask.
  const handleFormat = useCallback(() => {
    setContent(formatSQL(content))
  }, [content, setContent])

  const handleReset = useCallback(async () => {
    try {
      await reset()
      return true
    } catch {
      return false
    }
  }, [reset])

  const queryVisible = workspaceView === 'query'
  const canvasVisible = workspaceView === 'canvas'

  // Mount the Canvas workspace on first visit and leave it mounted. This is
  // a render-phase adjustment (not an effect) so the lazy chunk starts on
  // the same render that reveals Canvas.
  if (canvasVisible && !canvasMounted) setCanvasMounted(true)

  return (
    <div className="app-shell flex h-full flex-col overflow-hidden bg-bg text-text-primary">
      <a
        href="#main-workspace"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-1.5 focus:text-[13px] focus:font-medium focus:text-accent-ink"
      >
        Skip to workspace
      </a>
      <Navbar />
      <div id="main-workspace" tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
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
              id="workspace-panel-query"
              role="tabpanel"
              aria-labelledby="workspace-tab-query"
              aria-hidden={!queryVisible}
              className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden transition-opacity duration-200 motion-reduce:transition-none ${
                queryVisible ? 'opacity-100' : 'pointer-events-none invisible opacity-0'
              }`}
            >
              <div
                id="query-editor-region"
                className="flex min-h-0 flex-col"
                style={{ height: `${editorRatio}%` }}
              >
                <EditorToolbar
                  onRun={runQuery}
                  onFormat={handleFormat}
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

              <EditorResultsSeparator
                value={editorRatio}
                onChange={setEditorRatio}
                boundsRef={mainRef}
              />

              <div className="min-h-0 flex-1 overflow-hidden">
                <ResultsPanel result={lastResult} isExecuting={isExecuting} />
              </div>
            </div>

            {/* Canvas workspace — also kept mounted for pan/zoom/playback. */}
            <div
              id="workspace-panel-canvas"
              role="tabpanel"
              aria-labelledby="workspace-tab-canvas"
              aria-hidden={!canvasVisible}
              className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-surface transition-opacity duration-200 motion-reduce:transition-none ${
                canvasVisible ? 'opacity-100' : 'pointer-events-none invisible opacity-0'
              }`}
            >
              {canvasMounted && (
                <Suspense fallback={<CanvasLoadingFallback />}>
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
