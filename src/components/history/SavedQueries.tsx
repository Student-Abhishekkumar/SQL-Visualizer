import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useHistoryStore } from '../../store/historyStore'
import { useEditorStore } from '../../store/editorStore'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { summarizeSQL } from '../../services/sql/sqlFormatter'

/** Sidebar section: user-saved named queries, persisted in IndexedDB. */
export function SavedQueries() {
  const savedQueries = useHistoryStore((state) => state.savedQueries)
  const addSavedQuery = useHistoryStore((state) => state.addSavedQuery)
  const removeSavedQuery = useHistoryStore((state) => state.removeSavedQuery)
  const loadQuery = useEditorStore((state) => state.loadQuery)
  const currentContent = useEditorStore((state) => state.content)

  const [saveOpen, setSaveOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!name.trim()) {
      setError('Give the query a name.')
      return
    }
    if (!currentContent.trim()) {
      setError('The editor is empty — nothing to save.')
      return
    }
    await addSavedQuery(name, currentContent)
    setName('')
    setError(null)
    setSaveOpen(false)
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Saved Queries
        </span>
        <button
          onClick={() => setSaveOpen(true)}
          aria-label="Save current query"
          title="Save current query"
          className="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {savedQueries.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-text-muted/80">
          Nothing saved yet. Write a query and press + to keep it.
        </p>
      ) : (
        <ul className="px-1.5">
          {savedQueries.map((query) => (
            <li key={query.id} className="group relative">
              <button
                onClick={() => loadQuery(query.sql)}
                title={query.sql}
                className="block w-full rounded-md px-2 py-1.5 pr-8 text-left hover:bg-surface-2"
              >
                <span className="block truncate text-[13px] font-medium text-text-secondary group-hover:text-text-primary">
                  {query.name}
                </span>
                <span className="block truncate font-mono text-[11px] text-text-muted">
                  {summarizeSQL(query.sql, 46)}
                </span>
              </button>
              <button
                onClick={() => void removeSavedQuery(query.id)}
                aria-label={`Delete saved query ${query.name}`}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save query">
        <label className="block text-xs font-medium text-text-secondary" htmlFor="saved-query-name">
          Name
        </label>
        <input
          id="saved-query-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. High earners"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter') void handleSave()
          }}
          className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
        <p className="mt-2 truncate font-mono text-[11px] text-text-muted">
          {summarizeSQL(currentContent, 80)}
        </p>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSave()}>
            Save query
          </Button>
        </div>
      </Modal>
    </div>
  )
}
