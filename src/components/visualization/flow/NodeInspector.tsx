import { X } from 'lucide-react'
import { RowTable } from '../RowTable'
import type { FlowGraphNode } from '../../../types/flowGraph'
import type { StageSnapshot, VisualizationTrace } from '../../../types/visualization'

/**
 * Right-panel inspector for a selected flow-graph node. Every section
 * shows real data from the trace — the group member lookup resolves
 * row ids against the snapshot that actually fed the grouping stage.
 */

interface NodeInspectorProps {
  node: FlowGraphNode
  trace: VisualizationTrace
  onClose: () => void
}

/** The snapshot that fed the given stage (input rows for group members). */
function inputSnapshotOf(trace: VisualizationTrace, stage: FlowGraphNode['stage']): StageSnapshot | null {
  const index = trace.stageSnapshots.findIndex((snapshot) => snapshot.stage === stage)
  if (index <= 0) return null
  return trace.stageSnapshots[index - 1] ?? null
}

export function NodeInspector({ node, trace, onClose }: NodeInspectorProps) {
  const header = (() => {
    switch (node.kind) {
      case 'source':
        return { title: `Source table: ${node.table?.name ?? node.label}`, badge: node.table?.role === 'from' ? 'FROM' : (node.table?.joinType ?? 'JOIN') }
      case 'operation':
        return { title: `Operation: ${node.label}`, badge: node.stage ?? '' }
      case 'data':
        return { title: `Intermediate result: ${node.stage}`, badge: node.stage ?? '' }
      case 'branch':
        return { title: node.label, badge: 'removed' }
      case 'group':
        return { title: `Group: ${node.group?.key ?? node.label}`, badge: 'GROUP BY' }
      default:
        return { title: 'Final result', badge: 'result' }
    }
  })()

  return (
    <aside aria-label="Node inspector" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 py-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-text-secondary uppercase">
            {header.badge}
          </span>
          <h3 className="mt-1 truncate text-[13px] font-semibold text-text-primary">{header.title}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close node inspector"
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>

      {node.hint !== undefined && (
        <p className="rounded-lg border border-accent/25 bg-accent-soft/60 px-2.5 py-2 text-[11px] leading-relaxed text-text-secondary">
          {node.hint}
        </p>
      )}

      {node.kind === 'source' && node.table && (
        <>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-secondary">
            <p>
              {node.table.role === 'from'
                ? 'This table is the query’s FROM source.'
                : `Joined with ${node.table.joinType}${node.table.on !== null ? ` ON ${node.table.on}` : ''}.`}
            </p>
            <p className="mt-1.5">
              Real row count: <span className="font-medium text-text-primary">{node.table.rowCount}</span> ·
              columns: {node.table.columns.join(', ')}
            </p>
          </div>
          <RowTable columns={node.table.columns} rows={node.table.previewRows} animate={false} />
        </>
      )}

      {node.kind === 'operation' && (
        <>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-secondary">
            <p>
              The highlighted clause is{' '}
              <span className="font-mono text-text-primary">{node.detail}</span>.
            </p>
            {node.snapshot !== undefined && (
              <dl className="mt-2 grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="rounded border border-border/70 bg-surface px-2 py-1">
                  <dt className="text-[9px] tracking-wide text-text-muted uppercase">rows in</dt>
                  <dd className="font-mono text-text-primary">{node.snapshot.inputRowCount}</dd>
                </div>
                <div className="rounded border border-border/70 bg-surface px-2 py-1">
                  <dt className="text-[9px] tracking-wide text-text-muted uppercase">rows out</dt>
                  <dd className="font-mono text-text-primary">{node.snapshot.outputRowCount}</dd>
                </div>
              </dl>
            )}
            <p className="mt-2 text-[11px] text-text-muted">
              Use the query clause strip above (or switch to Table View) to inspect the exact input
              and output records of this operation.
            </p>
          </div>
        </>
      )}

      {node.kind === 'data' && node.snapshot && (
        <>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-secondary">
            <p className="text-[10px] font-medium tracking-wide text-text-muted uppercase">
              {node.label}
            </p>
            <p className="mt-1">{node.snapshot.explanation}</p>
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
              <span>
                Rows in: <span className="font-mono text-text-secondary">{node.snapshot.inputRowCount}</span>
              </span>
              <span>
                Rows out: <span className="font-mono text-text-secondary">{node.snapshot.outputRowCount}</span>
              </span>
              <span>
                Columns: <span className="font-mono text-text-secondary">{node.snapshot.columns.length}</span>
              </span>
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-text-muted" title={node.snapshot.columns.join(', ')}>
              {node.snapshot.columns.join(', ')}
            </p>
          </div>
          <RowTable
            columns={node.snapshot.columns}
            rows={node.snapshot.rows.slice(0, 20)}
            roles={node.snapshot.roles}
            animate={false}
          />
          {node.snapshot.rows.length > 20 && (
            <p className="text-[10px] text-text-muted">Showing the first 20 of {node.snapshot.rows.length} rows.</p>
          )}
        </>
      )}

      {node.kind === 'branch' && node.snapshot && (
        <>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-secondary">
            {node.snapshot.stage === 'LIMIT'
              ? 'These rows were skipped by OFFSET and are not part of the final result.'
              : node.snapshot.stage === 'DISTINCT'
                ? 'These projected rows duplicated an earlier row and were removed.'
                : 'These records failed the condition (or evaluated to UNKNOWN) and did not continue.'}
          </div>
          <RowTable
            columns={node.snapshot.columns}
            rows={node.removedRows ?? []}
            roles={node.snapshot.roles}
            animate={false}
          />
        </>
      )}

      {node.kind === 'group' && node.group && (() => {
        const input = inputSnapshotOf(trace, node.stage)
        const members = (input?.rows ?? []).filter((row) => node.group?.rowIds.includes(row.id))
        const aggregates = Object.entries(node.group.aggregates)
        return (
          <>
            <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-secondary">
              <p>
                Key: <span className="font-mono text-text-primary">{node.group.key}</span>
              </p>
              <p className="mt-1">Member rows: {node.group.rowIds.length}</p>
              {aggregates.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {aggregates.map(([name, value]) => (
                    <span
                      key={name}
                      className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                    >
                      {name} = <span className="text-text-primary">{value === null ? 'NULL' : String(value)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            {members.length > 0 && input !== null && (
              <>
                <h4 className="text-[10px] font-semibold tracking-wide text-text-muted uppercase">
                  Member rows (from {input.stage})
                </h4>
                <RowTable columns={input.columns} rows={members.slice(0, 20)} animate={false} />
              </>
            )}
          </>
        )
      })()}

      {node.kind === 'final' && (
        <>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-secondary">
            The logical simulation’s final rows — validated against SQLite’s real result when the
            trace reports validation.
          </div>
          <RowTable
            columns={node.snapshot?.columns ?? trace.finalColumns}
            rows={node.rows ?? trace.finalRows}
            animate={false}
          />
        </>
      )}
    </aside>
  )
}
