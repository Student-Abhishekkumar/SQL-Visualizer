import { lazy, Suspense } from 'react'

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
    <Suspense
      fallback={
        <div className="flex h-full min-h-0 w-full items-center justify-center text-sm text-text-muted">
          Loading editor…
        </div>
      }
    >
      <SQLEditorSurface {...props} />
    </Suspense>
  )
}
