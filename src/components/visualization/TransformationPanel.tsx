import { useMemo } from 'react'
import { ArrowDown, ArrowRight, Users } from 'lucide-react'
import { RowTable } from './RowTable'
import type { StageSnapshot, VisualizedStage } from '../../types/visualization'

/**
 * Center panel: the data transformation view — input rows, the current
 * stage's transformation and its output, with highlights driven by the
 * snapshot roles.
 */

interface TransformationPanelProps {
  snapshot: StageSnapshot | null
  activeStage: VisualizedStage | null
  /** Stage currently selected for inspection (overrides playback view). */
  inspecting: boolean
}

function StageDescription({ stage }: { stage: VisualizedStage }) {
  switch (stage) {
    case 'WHERE':
      return 'Red rows failed the condition and are filtered out; remaining rows continue.'
    case 'GROUP_BY':
      return 'Rows with equal key values are collected into the same group.'
    case 'HAVING':
      return 'Groups that fail the condition are removed.'
    case 'DISTINCT':
      return 'Duplicate projected rows are struck through and removed.'
    case 'COMPOUND':
      return 'The SELECT branches are combined here; UNION strikes through duplicates it removes, UNION ALL keeps every row.'
    case 'ORDER_BY':
      return 'Rows animate into their sorted positions.'
    case 'LIMIT':
      return 'Skipped rows are muted; selected rows form the final result.'
    case 'FROM':
      return 'The original dataset loaded from the table.'
    case 'JOIN':
      return 'Rows of both tables combined by the ON condition.'
    case 'SELECT':
      return 'Each row projected to the selected columns.'
  }
}

export function TransformationPanel({ snapshot, activeStage, inspecting }: TransformationPanelProps) {
  const highlightColumns = useMemo(() => {
    if (snapshot === null) return []
    // For WHERE/HAVING highlight nothing structural; for SELECT the new
    // columns are all "new". Keep it simple: no column highlights yet.
    return []
  }, [snapshot])

  if (snapshot === null) {
    return (
      <section
        aria-label="Data transformation"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <ArrowRight className="size-5 text-text-muted" aria-hidden />
        <p className="max-w-72 text-xs leading-relaxed text-text-muted">
          The visualization will show how SQL transforms the source rows stage by
          stage. Press Play below to start.
        </p>
      </section>
    )
  }

  const isGroupStage = snapshot.groups.length > 0
  const showRemoved =
    snapshot.removedRows.length > 0 &&
    (snapshot.stage === 'WHERE' || snapshot.stage === 'HAVING' || snapshot.stage === 'DISTINCT' || snapshot.stage === 'LIMIT')

  return (
    <section
      aria-label="Data transformation"
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-[13px] font-semibold text-text-primary">
              {snapshot.label}
            </h3>
            {inspecting && (
              <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted">
                inspecting
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-text-muted">
            <StageDescription stage={snapshot.stage} />
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] tabular-nums text-text-muted">
          <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5">
            {snapshot.inputRowCount} in
          </span>
          <ArrowRight className="size-3" aria-hidden />
          <span className="rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 text-accent">
            {snapshot.outputRowCount} out
          </span>
        </div>
      </header>

      {activeStage !== null && !inspecting && (
        <div className="flex items-center gap-1.5 text-[11px] text-accent">
          <ArrowDown className="size-3 animate-bounce" aria-hidden />
          running {activeStage}…
        </div>
      )}

      {/* Groups view for GROUP BY / HAVING */}
      {isGroupStage ? (
        <div className="space-y-2">
          {snapshot.groups.map((group) => (
            <div key={group.index} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
                  <Users className="size-3.5 text-purple" aria-hidden />
                  Group {group.index}: <span className="font-mono">{group.key}</span>
                </span>
                <span className="text-[11px] text-text-muted">
                  {group.rowIds.length} row{group.rowIds.length === 1 ? '' : 's'}
                </span>
              </div>
              {Object.keys(group.aggregates).length > 0 && (
                <div className="flex flex-wrap gap-2 px-3 py-1.5">
                  {Object.entries(group.aggregates).map(([name, value]) => (
                    <span
                      key={name}
                      className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-secondary"
                    >
                      {name} = <span className="text-text-primary">{value === null ? 'NULL' : String(value)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <RowTable
          columns={snapshot.columns}
          rows={snapshot.rows}
          roles={snapshot.roles}
          highlightColumns={highlightColumns}
        />
      )}

      {showRemoved && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
            {snapshot.stage === 'LIMIT'
              ? `Skipped by OFFSET (${snapshot.removedRows.length})`
              : `Removed rows (${snapshot.removedRows.length})`}
          </h4>
          <RowTable
            columns={snapshot.columns}
            rows={snapshot.removedRows}
            roles={snapshot.roles}
            animate={false}
          />
        </div>
      )}

      {snapshot.truncated && (
        <p className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-warning">
          Rows were capped for visualization. The real SQLite result is unaffected.
        </p>
      )}
    </section>
  )
}
