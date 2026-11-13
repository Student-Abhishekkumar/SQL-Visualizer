import { useState } from 'react'
import { CircleAlert, Table2 } from 'lucide-react'
import { Tabs } from '../common/Tabs'
import { ResultsTable } from './ResultsTable'
import { MessagesPanel } from './MessagesPanel'
import { QueryInfo } from './QueryInfo'
import type { QueryExecutionResult } from '../../types/query'

interface ResultsPanelProps {
  result: QueryExecutionResult | null
  isExecuting: boolean
}

const TAB_RESULTS = 'results'
const TAB_MESSAGES = 'messages'
const TAB_INFO = 'info'

/**
 * Output area: actual result grid, execution messages and metadata.
 * Switches to Messages automatically when a query fails, but a manual
 * selection always wins for the result it was made on.
 */
export function ResultsPanel({ result, isExecuting }: ResultsPanelProps) {
  // Tab choice is scoped to the result it was made on; when a new
  // result arrives the panel falls back to automatic selection.
  const [selection, setSelection] = useState<{
    result: QueryExecutionResult | null
    tab: string
  } | null>(null)

  const autoTab = result ? (result.success ? TAB_RESULTS : TAB_MESSAGES) : TAB_RESULTS
  const activeTab = selection && selection.result === result ? selection.tab : autoTab

  // The primary statement whose result set is displayed.
  const primaryStatement = result?.statements.find(
    (statement) => statement.hasResultSet,
  ) ?? null

  const errorCount =
    result && !result.success ? 1 : 0

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <Tabs
          active={activeTab}
          onChange={(tab) => setSelection({ result, tab })}
          tabs={[
            {
              id: TAB_RESULTS,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <Table2 className="size-3.5" />
                  Results
                </span>
              ),
              badge:
                result?.success && result.rowCount > 0 ? (
                  <Badge>{result.rowCount}</Badge>
                ) : null,
            },
            {
              id: TAB_MESSAGES,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <CircleAlert className="size-3.5" />
                  Messages
                </span>
              ),
              badge: errorCount > 0 ? <Badge variant="error">{errorCount}</Badge> : null,
            },
            { id: TAB_INFO, label: 'Query Information' },
          ]}
        />
        <div className="pr-1 text-[11px] text-text-muted">
          {isExecuting
            ? 'Executing…'
            : result
              ? result.success
                ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'} · ${formatDuration(result.executionTime)}`
                : `Failed after ${formatDuration(result.executionTime)}`
              : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === TAB_RESULTS && (
          <ResultsTable
            result={primaryStatement}
            executedWithoutResultSet={
              result?.success === true && primaryStatement === null
            }
          />
        )}
        {activeTab === TAB_MESSAGES && (
          <MessagesPanel result={result} />
        )}
        {activeTab === TAB_INFO && <QueryInfo result={result} />}
      </div>
    </section>
  )
}

function Badge({ children, variant }: { children: React.ReactNode; variant?: 'error' }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
        variant === 'error'
          ? 'bg-danger-soft text-danger'
          : 'bg-accent-soft text-accent'
      }`}
    >
      {children}
    </span>
  )
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 1000) return `${ms.toFixed(0)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}
