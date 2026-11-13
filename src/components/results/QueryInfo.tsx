import type { QueryExecutionResult } from '../../types/query'
import { getReferencedTables } from '../../services/sql/sqlParser'
import { getLiveDatabase } from '../../services/database/databaseInitializer'

interface QueryInfoProps {
  result: QueryExecutionResult | null
}

/**
 * Execution metadata — only real, observed facts:
 * statement types, timings, row counts, referenced tables and the
 * SQLite library version. No invented statistics.
 */
export function QueryInfo({ result }: QueryInfoProps) {
  const sqliteVersion = (() => {
    try {
      return getLiveDatabase()?.sqliteVersion() ?? null
    } catch {
      return null
    }
  })()

  const tables = result
    ? [
        ...new Set(
          result.statements.flatMap((statement) =>
            getReferencedTables(statement.statement),
          ),
        ),
      ]
    : []

  if (!result) {
    return (
      <div className="p-4 text-sm text-text-muted">
        Execute a query to see its metadata here.
      </div>
    )
  }

  const rowsModified = result.statements.reduce(
    (total, statement) => total + (statement.rowsModified ?? 0),
    0,
  )

  return (
    <div className="space-y-4 p-4">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Execution
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[13px]">
          <InfoRow label="Status">
            <span className={result.success ? 'text-success' : 'text-danger'}>
              {result.success ? 'Success' : 'Failed'}
            </span>
          </InfoRow>
          <InfoRow label="Statements">
            {result.statements.length}
            {result.statements.length > 0 && (
              <span className="ml-2 text-text-muted">
                {result.statements.map((statement) => statement.statementType).join(', ')}
              </span>
            )}
          </InfoRow>
          <InfoRow label="Total time">
            {result.executionTime < 1000
              ? `${result.executionTime.toFixed(1)} ms`
              : `${(result.executionTime / 1000).toFixed(2)} s`}
          </InfoRow>
          <InfoRow label="Rows returned">
            {result.rowCount}
          </InfoRow>
          {rowsModified > 0 && (
            <InfoRow label="Rows modified">{rowsModified}</InfoRow>
          )}
          <InfoRow label="Query length">
            {result.query.length.toLocaleString()} characters
          </InfoRow>
        </dl>
      </section>

      {result.statements.length > 1 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Per statement
          </h3>
          <ul className="space-y-1">
            {result.statements.map((statement, index) => (
              <li
                key={index}
                className="flex items-center justify-between gap-4 rounded-md bg-surface-2 px-3 py-1.5 text-xs"
              >
                <span className="text-text-secondary">
                  #{index + 1} · {statement.statementType}
                </span>
                <span className="font-mono text-text-muted">
                  {statement.executionTime < 1000
                    ? `${statement.executionTime.toFixed(1)} ms`
                    : `${(statement.executionTime / 1000).toFixed(2)} s`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tables.length > 0 && (
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Tables referenced
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {tables.map((table) => (
              <span
                key={table}
                className="rounded-md border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-secondary"
              >
                {table}
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          Engine
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[13px]">
          <InfoRow label="SQLite version">{sqliteVersion ?? '—'}</InfoRow>
          <InfoRow label="Runtime">SQLite compiled to WebAssembly (sql.js)</InfoRow>
        </dl>
      </section>
    </div>
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-text-primary">{children}</dd>
    </>
  )
}
