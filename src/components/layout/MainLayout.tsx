import { useCallback, useRef, useState } from 'react'
import { Navbar } from './Navbar'
import { Sidebar } from './Sidebar'
import { SQLEditor } from '../editor/SQLEditor'
import { EditorToolbar } from '../editor/EditorToolbar'
import { ResultsPanel } from '../results/ResultsPanel'
import { VisualizationWorkspace } from '../visualization/VisualizationWorkspace'
import { useEditorStore } from '../../store/editorStore'
import { useDatabaseStore } from '../../store/databaseStore'
import { useVisualizationStore } from '../../store/visualizationStore'
import { useSQLExecution } from '../../hooks/useSQLExecution'
import { formatSQL } from '../../services/sql/sqlFormatter'
import { splitStatements } from '../../utils/queryHelpers'

const MIN_SPLIT = 20
const MAX_SPLIT = 80

/**
 * Main workspace shell: navbar + (explorer | editor ⇅ results).
 * The editor/results divider is draggable; editor content persists
 * across tab switches because it lives in the editor store.
 * "Visualize" switches the area below the toolbar into the
 * visualization workspace mode without touching the execution path.
 */
export function MainLayout() {
  const content = useEditorStore((state) => state.content)
  const setContent = useEditorStore((state) => state.setContent)
  const loadQuery = useEditorStore((state) => state.loadQuery)
  const clear = useEditorStore((state) => state.clear)
  const isExecuting = useDatabaseStore((state) => state.isExecuting)
  const lastResult = useDatabaseStore((state) => state.lastResult)
  const reset = useDatabaseStore((state) => state.reset)
  const visualize = useVisualizationStore((state) => state.visualize)
  const { execute } = useSQLExecution()

  const [editorRatio, setEditorRatio] = useState(52)
  const [mode, setMode] = useState<'results' | 'visualization'>('results')
  const mainRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const runQuery = useCallback(() => {
    void execute(content)
  }, [execute, content])

  const handleVisualize = useCallback(() => {
    visualize(content, splitStatements(content))
    setMode('visualization')
  }, [visualize, content])

  const handleReset = useCallback(async () => {
    const schema = await reset()
    return schema !== null
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg text-text-primary">
      <Navbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div ref={mainRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {mode === 'visualization' ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <VisualizationWorkspace
                queryName={content.trim() === '' ? '(empty query)' : content.trim().split('\n')[0] ?? ''}
                onClose={() => setMode('results')}
              />
            </div>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
