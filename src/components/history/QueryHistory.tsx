import { Trash2 } from 'lucide-react'
import { useHistoryStore } from '../../store/historyStore'
import { useEditorStore } from '../../store/editorStore'
import { summarizeSQL } from '../../services/sql/sqlFormatter'
import type { HistoryEntry } from '../../types/query'

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatDuration(ms: number): string {
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

interface QueryHistoryProps {
  onClearRequest: () => void
}

/** Sidebar section: recent executions with outcome and duration. */
export function QueryHistory({ onClearRequest }: QueryHistoryProps) {
  const history = useHistoryStore((state) => state.history)
  const removeHistoryEntry = useHistoryStore((state) => state.removeHistoryEntry)
  const loadQuery = useEditorStore((state) => state.loadQuery)

  return (
    <div className="flex min-h-[120px] flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Query History
        </span>
        {history.length > 0 && (
          <button
            onClick={onClearRequest}
            aria-label="Clear query history"
            title="Clear all history"
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-text-muted/80">
          Executed queries appear here and survive page refreshes.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {history.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              onLoad={() => loadQuery(entry.sql)}
              onDelete={() => void removeHistoryEntry(entry.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function HistoryRow({
  entry,
  onLoad,
  onDelete,
}: {
  entry: HistoryEntry
  onLoad: () => void
  onDelete: () => void
}) {
  return (
    <li className="group relative">
      <button
        onClick={onLoad}
        title={entry.sql}
        className="block w-full rounded-md px-2 py-1.5 pr-8 text-left hover:bg-surface-2"
      >
        <div className="flex items-center gap-2">
          <span
            className={`size-1.5 shrink-0 rounded-full ${
              entry.success ? 'bg-success' : 'bg-danger'
            }`}
            aria-label={entry.success ? 'Succeeded' : 'Failed'}
          />
          <span className="rounded bg-surface-3 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-muted">
            {entry.statementType}
          </span>
          <span className="ml-auto font-mono text-[10px] text-text-muted">
            {formatDuration(entry.executionTime)}
          </span>
        </div>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-text-secondary">
          {summarizeSQL(entry.sql, 52)}
        </span>
        <span className="block text-[10px] text-text-muted/70">
          {formatRelativeTime(entry.timestamp)}
          {entry.success && entry.rowCount > 0
            ? ` · ${entry.rowCount} row${entry.rowCount === 1 ? '' : 's'}`
            : ''}
        </span>
      </button>
      <button
        onClick={onDelete}
        aria-label="Delete this history entry"
        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  )
}
