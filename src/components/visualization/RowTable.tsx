import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { RowRole, StageSnapshot } from '../../types/visualization'

/**
 * Animated data table for one visualization snapshot. Rows are keyed by
 * their stable ids (never array positions), so Motion's layout
 * animations track rows across filter/sort/limit transformations.
 */

const ROLE_STYLES: Record<RowRole, string> = {
  unchanged: '',
  accepted: 'bg-success/10',
  filtered: 'opacity-40 line-through',
  duplicated: 'opacity-40 bg-warning/10 line-through',
  selected: 'bg-accent-soft',
  skipped: 'opacity-40',
  grouped: 'bg-purple/10',
}

/** Small text renderer that keeps NULL visually distinct. */
function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="italic text-text-muted">NULL</span>
  }
  return <>{String(value)}</>
}

interface RowTableProps {
  columns: string[]
  rows: { id: string; values: unknown[] }[]
  /** Row id → role styling. Missing = unchanged. */
  roles?: StageSnapshot['roles']
  /** Column indexes to emphasize (the evaluated expression). */
  highlightColumns?: number[]
  /** Offset added to the 1-based row number (for paginated slices). */
  startIndex?: number
  animate?: boolean
}

export function RowTable({
  columns,
  rows,
  roles,
  highlightColumns,
  startIndex = 0,
  animate = true,
}: RowTableProps) {
  const reducedMotion = useReducedMotion()
  const shouldAnimate = animate && !reducedMotion

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-text-muted">
        No rows
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="bg-surface-2">
            <th className="w-8 border-b border-border px-2 py-1.5 font-normal text-text-muted">#</th>
            {columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                className={`border-b border-border px-2.5 py-1.5 font-medium whitespace-nowrap ${
                  highlightColumns?.includes(index) === true
                    ? 'text-accent'
                    : 'text-text-secondary'
                }`}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {rows.map((row, index) => {
              const role = roles?.[row.id] ?? 'unchanged'
              return (
                <motion.tr
                  key={row.id}
                  layout={shouldAnimate}
                  initial={shouldAnimate ? { opacity: 0, y: 4 } : undefined}
                  animate={{ opacity: 1, y: 0 }}
                  exit={shouldAnimate ? { opacity: 0 } : undefined}
                  transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
                  className={`border-b border-border/50 last:border-b-0 transition-colors ${ROLE_STYLES[role]}`}
                >
                  <td className="px-2 py-1.5 text-[10px] text-text-muted">{startIndex + index + 1}</td>
                  {row.values.map((value, valueIndex) => (
                    <td
                      key={valueIndex}
                      className={`max-w-40 truncate px-2.5 py-1.5 font-mono text-[11px] whitespace-nowrap ${
                        highlightColumns?.includes(valueIndex) === true
                          ? 'text-accent'
                          : 'text-text-primary'
                      }`}
                    >
                      <Value value={value} />
                    </td>
                  ))}
                </motion.tr>
              )
            })}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  )
}
