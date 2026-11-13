import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { setSchemaAccessor, setupMonaco, monaco } from '../../app/monacoSetup'
import { useDatabaseStore } from '../../store/databaseStore'
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
 */
export function SQLEditor({ value, onChange, onRun }: SQLEditorProps) {
  const theme = useUIStore((state) => state.theme)
  const schema = useDatabaseStore((state) => state.schema)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
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
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onRunRef.current()
    })
  }

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
