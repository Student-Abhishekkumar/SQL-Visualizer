import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useHistoryStore } from '../../store/historyStore'
import { useEditorStore } from '../../store/editorStore'
import { useDatabaseStore } from '../../store/databaseStore'
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

/**
 * Sidebar section: recent executions with outcome and duration.
 * Filtered to the active database by default so queries executed
 * against different databases are never conflated.
 */
export function QueryHistory({ onClearRequest }: QueryHistoryProps) {
  const history = useHistoryStore((state) => state.history)
  const removeHistoryEntry = useHistoryStore((state) => state.removeHistoryEntry)
  const loadQuery = useEditorStore((state) => state.loadQuery)
  const activeDatabaseId = useDatabaseStore((state) => state.activeDatabaseId)
  const databases = useDatabaseStore((state) => state.databases)

  const [scope, setScope] = useState<'current' | 'all'>('current')

  const visible =
    scope === 'current' && activeDatabaseId !== null
      ? history.filter((entry) => entry.databaseId === activeDatabaseId)
      : history

  const nameById = new Map(databases.map((database) => [database.id, database.name]))

  return (
    <div className="flex min-h-[120px] flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Query History
        </span>
        <div className="flex items-center gap-0.5">
          {history.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setScope('current')}
                aria-pressed={scope === 'current'}
                className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide transition-colors ${
                  scope === 'current'
                    ? 'bg-accent-soft text-accent'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                This DB
              </button>
              <button
                type="button"
                onClick={() => setScope('all')}
                aria-pressed={scope === 'all'}
                className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide transition-colors ${
                  scope === 'all'
                    ? 'bg-accent-soft text-accent'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                All
              </button>
              <button
                onClick={onClearRequest}
                aria-label="Clear query history"
                title="Clear all history"
                className="ml-0.5 rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="px-3 pb-2 text-[11px] leading-relaxed text-text-muted/80">
          {history.length === 0
            ? 'Executed queries appear here and survive page refreshes.'
            : scope === 'current'
              ? 'No queries yet for this database.'
              : 'No history entries.'}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {visible.map((entry) => (
            <HistoryRow
              key={entry.id}
              entry={entry}
              databaseName={
                entry.databaseId === undefined
                  ? undefined
                  : (nameById.get(entry.databaseId) ?? 'Deleted database')
              }
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
  databaseName,
  onLoad,
  onDelete,
}: {
  entry: HistoryEntry
  databaseName?: string
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
          {databaseName !== undefined && (
            <span className="max-w-24 truncate rounded border border-border px-1 py-0.5 text-[9px] text-text-muted">
              {databaseName}
            </span>
          )}
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
