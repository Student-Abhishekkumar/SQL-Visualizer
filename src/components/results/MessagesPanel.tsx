import { CheckCircle2, Lightbulb, XCircle } from 'lucide-react'
import type { QueryExecutionResult } from '../../types/query'
import { summarizeSQL } from '../../services/sql/sqlFormatter'

interface MessagesPanelProps {
  result: QueryExecutionResult | null
}

/** Execution feedback: per-statement outcomes and full error details. */
export function MessagesPanel({ result }: MessagesPanelProps) {
  if (!result) {
    return (
      <div className="space-y-2.5 p-4 text-sm text-text-muted">
        <Message>
          Press <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> (or click Run) to execute the
          query in the editor.
        </Message>
        <Message>
          Multiple statements separated by semicolons run sequentially —
          execution stops at the first error.
        </Message>
        <Message>
          Use the Examples menu for ready-to-run queries against the seeded
          University Database.
        </Message>
      </div>
    )
  }

  if (!result.success && result.statements.length === 0) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft p-3">
          <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-danger">{result.error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5 p-3">
      {result.statements.map((statement, index) => (
        <div
          key={index}
          className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span className="font-semibold text-text-primary">
                #{index + 1} {statement.statementType}
              </span>
              <span className="text-text-muted">
                {statement.hasResultSet
                  ? `${statement.rowCount} row${statement.rowCount === 1 ? '' : 's'} returned`
                  : statement.rowsModified !== null
                    ? `${statement.rowsModified} row${statement.rowsModified === 1 ? '' : 's'} modified`
                    : 'completed'}
              </span>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted">
                {formatMilliseconds(statement.executionTime)}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-[11px] text-text-muted">
              {summarizeSQL(statement.statement, 110)}
            </p>
          </div>
        </div>
      ))}

      {!result.success && (
        <div className="flex items-start gap-2.5 rounded-lg border border-danger/40 bg-danger-soft p-3">
          <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-danger">
              Statement #{(result.errorStatementIndex ?? 0) + 1} failed
            </p>
            <p className="mt-1 text-sm text-danger">{result.error}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning/70" />
      <p className="text-[13px] leading-relaxed text-text-secondary">{children}</p>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-text-primary">
      {children}
    </kbd>
  )
}

function formatMilliseconds(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
