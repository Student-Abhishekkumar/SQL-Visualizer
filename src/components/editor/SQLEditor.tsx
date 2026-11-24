import { lazy, Suspense } from 'react'
import { EditorLoadingFallback } from './EditorLoadingFallback'

interface SQLEditorProps {
  value: string
  onChange: (value: string) => void
  onRun: () => void
}

/**
 * Lightweight editor boundary. Monaco and the SQL language support are
 * loaded on demand so the initial workspace shell does not wait for the
 * editor bundle. The surface is kept mounted after its first render, so
 * editor content, selection and decorations survive workspace switches.
 */
const SQLEditorSurface = lazy(() => import('./SQLEditorSurface'))

export function SQLEditor(props: SQLEditorProps) {
  return (
    <Suspense fallback={<EditorLoadingFallback />}>
      <SQLEditorSurface {...props} />
    </Suspense>
  )
}
