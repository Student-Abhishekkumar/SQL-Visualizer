import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { setSchemaAccessor, setupMonaco, monaco } from '../../app/monacoSetup'
import { useDatabaseStore } from '../../store/databaseStore'
import { useEditorStore } from '../../store/editorStore'
import { useUIStore } from '../../store/uiStore'

interface SQLEditorProps {
  value: string
  onChange: (value: string) => void
  onRun: () => void
}

/**
 * Monaco-based SQL editor: syntax highlighting, line numbers, bracket
 * matching, schema-aware autocomplete, Ctrl+Enter execution, and an
 * app-theme-matched dark/light appearance. Content lives in the editor
 * store, so it survives tab switches and re-renders.
 *
 * Playback sync: when the visualization store publishes a clause
 * highlight (character offsets from the clause mapper), the editor
 * decorates that range and scrolls it into view. Decoration state is
 * re-derived on mount, so the highlight survives the editor being
 * unmounted while the Visualize tab is open.
 */
export function SQLEditor({ value, onChange, onRun }: SQLEditorProps) {
  const theme = useUIStore((state) => state.theme)
  const schema = useDatabaseStore((state) => state.schema)
  const stageHighlight = useEditorStore((state) => state.stageHighlight)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const onRunRef = useRef(onRun)

  useEffect(() => {
    onRunRef.current = onRun
  }, [onRun])

  useEffect(() => {
    setupMonaco()
  }, [])

  // Keep the completion provider fed with the live schema.
  useEffect(() => {
    setSchemaAccessor(() => schema?.tables ?? [])
  }, [schema])

  useEffect(() => {
    editorRef.current?.updateOptions({
      quickSuggestions: true,
    })
  }, [])

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    decorationsRef.current = editor.createDecorationsCollection([])
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRunRef.current()
    })
    // Re-apply any highlight that was set while the editor was unmounted.
    applyHighlight(useEditorStore.getState().stageHighlight)
  }

  /** Decorate (or clear) the playback-synced clause range. */
  const applyHighlight = (
    highlight: { start: number; end: number; stage: string } | null,
  ): void => {
    const editor = editorRef.current
    const decorations = decorationsRef.current
    if (editor === null || decorations === null) return
    const model = editor.getModel()
    if (model === null) return
    if (highlight === null) {
      decorations.set([])
      return
    }
    const { start, end } = highlight
    if (start < 0 || end <= start || end > model.getValueLength()) {
      decorations.set([])
      return
    }
    const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end))
    decorations.set([
      {
        range,
        options: {
          className: 'clause-highlight-monaco',
          overviewRuler: { color: '#2563eb', position: monaco.editor.OverviewRulerLane.Right },
        },
      },
    ])
    editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
  }

  // Playback-synced clause decoration. The range comes from the clause
  // mapper's character offsets; a stale or out-of-range highlight is
  // silently ignored rather than decorating wrong text.
  useEffect(() => {
    applyHighlight(stageHighlight)
  }, [stageHighlight, value])

  return (
    <div className="h-full min-h-0 w-full">
      <Editor
        language="sql"
        theme={theme === 'dark' ? 'sqlviz-dark' : 'sqlviz-light'}
        value={value}
        onChange={(next) => onChange(next ?? '')}
        onMount={handleMount}
        options={{
          fontSize: 13.5,
          lineHeight: 1.6,
          fontLigatures: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
          tabSize: 2,
          renderLineHighlight: 'line',
          padding: { top: 12, bottom: 12 },
          lineNumbersMinChars: 3,
          bracketPairColorization: { enabled: true },
          matchBrackets: 'always',
          autoClosingBrackets: 'languageDefined',
          quickSuggestions: { other: true, comments: false, strings: false },
          suggestOnTriggerCharacters: true,
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        }}
        loading={
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            Loading editor…
          </div>
        }
      />
    </div>
  )
}
