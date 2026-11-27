import { useMemo } from 'react'
import { Inbox } from 'lucide-react'
import { EmptyState } from '../common/EmptyState'
import type { StatementResult } from '../../types/query'

interface ResultsTableProps {
  result: StatementResult | null
  /** True when the whole execution succeeded but produced no result set. */
  executedWithoutResultSet?: boolean
}

/** Infer a display type from the first non-null value in a column. */
function inferType(values: unknown[][], columnIndex: number): string {
  for (const row of values) {
    const value = row[columnIndex]
    if (value === null || value === undefined) continue
    if (typeof value === 'number') return 'NUM'
    if (typeof value === 'bigint') return 'NUM'
    if (value instanceof Uint8Array) return 'BLOB'
    return 'TEXT'
  }
  return ''
}

function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: 'NULL', isNull: true }
  }
  if (value instanceof Uint8Array) {
    return { text: `BLOB (${value.length} bytes)`, isNull: false }
  }
  if (typeof value === 'object') {
    return { text: JSON.stringify(value), isNull: false }
  }
  return { text: String(value), isNull: false }
}

/**
 * Narrow result sets read better when columns keep their content width and a
 * trailing spacer absorbs the leftover space. Wider sets still distribute
 * across the full table so every column stays legible.
 */
const COMPACT_LAYOUT_MAX_COLUMNS = 3

/** Cells at least this long may be clipped by `max-w-72`, so expose the value. */
const CELL_TITLE_MIN_LENGTH = 32

/** Renders one real SQLite result set as a scrollable data grid. */
export function ResultsTable({ result, executedWithoutResultSet = false }: ResultsTableProps) {
  const columnTypes = useMemo(() => {
    if (!result) return []
    return result.columns.map((_, columnIndex) => inferType(result.values, columnIndex))
  }, [result])

  if (!result) {
    return (
      <EmptyState
        icon={<Inbox className="size-8" />}
        title={executedWithoutResultSet ? 'Statement executed' : 'No results yet'}
        description={
          executedWithoutResultSet
            ? undefined
            : 'Run a query to see its output here, or pick an example from the toolbar.'
        }
      />
    )
  }

  if (!result.hasResultSet) {
    return (
      <EmptyState
        icon={<Inbox className="size-8" />}
        title="Statement executed successfully"
        description="This statement does not return rows."
      />
    )
  }

  if (result.rowCount === 0) {
    return (
      <EmptyState
        icon={<Inbox className="size-8" />}
        title="Query returned no rows"
        description="The statement is valid, but no rows matched the conditions."
      />
    )
  }

  const compactLayout = result.columns.length <= COMPACT_LAYOUT_MAX_COLUMNS

  return (
    <div className="h-full min-h-0 overflow-auto">
      <table className="w-max min-w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface-3">
            <th className="sticky left-0 z-20 w-10 min-w-10 border-b border-r border-border bg-surface-3 px-2 py-1.5 text-right text-[11px] font-medium text-text-muted">
              #
            </th>
            {result.columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                className={`border-b border-border px-3 py-1.5 text-left font-semibold text-text-primary ${
                  compactLayout ? 'min-w-28' : ''
                }`}
              >
                <span className="mr-1.5">{column}</span>
                {columnTypes[index] && (
                  <span className="rounded bg-surface px-1 py-0.5 align-middle text-[9px] font-medium tracking-wide text-text-muted">
                    {columnTypes[index]}
                  </span>
                )}
              </th>
            ))}
            {compactLayout && <th aria-hidden="true" className="w-full border-b border-border" />}
          </tr>
        </thead>
        <tbody>
          {result.values.map((row, rowIndex) => (
            <tr key={rowIndex} className="group hover:bg-surface-2">
              <td className="sticky left-0 z-[5] border-b border-r border-border bg-surface px-2 py-1.5 text-right text-[11px] text-text-muted group-hover:bg-surface-2">
                {rowIndex + 1}
              </td>
              {result.columns.map((_, columnIndex) => {
                const { text, isNull } = formatCell(row[columnIndex])
                const isNumber = columnTypes[columnIndex] === 'NUM' && !isNull
                return (
                  <td
                    key={columnIndex}
                    title={text.length >= CELL_TITLE_MIN_LENGTH ? text : undefined}
                    className={`max-w-72 truncate border-b border-border px-3 py-1.5 font-mono text-[12.5px] ${
                      compactLayout ? 'min-w-28' : ''
                    } ${
                      isNull
                        ? 'italic text-text-muted/70'
                        : isNumber
                          ? 'text-right text-text-primary'
                          : 'text-text-secondary'
                    }`}
                  >
                    {text}
                  </td>
                )
              })}
              {compactLayout && <td aria-hidden="true" className="border-b border-border" />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
