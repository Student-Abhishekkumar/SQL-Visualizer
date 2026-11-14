import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Database,
  Filter,
  GitMerge,
  Layers,
  ListOrdered,
  Scissors,
  Sparkles,
  Table2,
  Waypoints,
} from 'lucide-react'
import type { FlowElementStatus, FlowGraphNode } from '../../../types/flowGraph'
import type { RowRole, VisualizedStage } from '../../../types/visualization'

/**
 * Renders one flow-graph node. All displayed data comes from real
 * snapshots / source-table metadata — previews are genuine rows.
 *
 * Nodes are keyboard-accessible (role="button" + Enter/Space) so the
 * preview expand control can be a real nested <button>.
 */

const STATUS_RING: Record<FlowElementStatus, string> = {
  completed: 'border-border bg-surface',
  active: 'border-accent bg-surface ring-2 ring-accent/35 shadow-md',
  pending: 'border-border bg-surface opacity-75',
  hidden: '',
}

const ROLE_CELL_CLASSES: Record<RowRole, string> = {
  unchanged: '',
  accepted: 'text-success',
  filtered: 'text-danger line-through opacity-70',
  duplicated: 'text-warning line-through opacity-70',
  selected: 'text-accent font-medium',
  skipped: 'text-text-muted line-through opacity-70',
  grouped: 'text-purple',
}

/** Pipeline stages get distinct but restrained accent colors. */
const STAGE_ACCENT: Partial<Record<VisualizedStage, string>> = {
  JOIN: 'text-purple',
  WHERE: 'text-warning',
  GROUP_BY: 'text-purple',
  HAVING: 'text-purple',
  SELECT: 'text-accent',
  DISTINCT: 'text-success',
  ORDER_BY: 'text-text-secondary',
  LIMIT: 'text-text-secondary',
}

const STAGE_ICONS: Partial<Record<VisualizedStage, typeof Filter>> = {
  JOIN: GitMerge,
  WHERE: Filter,
  GROUP_BY: Layers,
  HAVING: Layers,
  SELECT: Scissors,
  DISTINCT: Sparkles,
  ORDER_BY: ListOrdered,
  LIMIT: Waypoints,
}

const PREVIEW_ROWS = 3
const EXPANDED_ROWS = 10

/** Compact value display; NULL is always visually distinct. */
function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="italic text-text-muted/80">NULL</span>
  }
  return <>{String(value)}</>
}

function MiniPreview({
  columns,
  rows,
  roles,
  limit,
}: {
  columns: string[]
  rows: { id: string; values: unknown[] }[]
  roles?: Record<string, RowRole>
  limit: number
}) {
  const preview = rows.slice(0, limit)
  if (preview.length === 0) {
    return (
      <div className="mt-1 rounded-md border border-dashed border-border px-2 py-1.5 text-center text-[10px] text-text-muted">
        no rows
      </div>
    )
  }
  return (
    <div className="mt-1 overflow-hidden rounded-md border border-border/70">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="bg-surface-2/70">
            {columns.slice(0, 4).map((column, index) => (
              <th
                key={`${column}-${index}`}
                className="truncate px-1.5 py-0.5 text-[9px] font-medium text-text-muted"
                title={column}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.map((row, rowIndex) => {
            const role = roles?.[row.id] ?? 'unchanged'
            return (
              <tr key={row.id} className={rowIndex % 2 === 1 ? 'bg-surface-2/35' : undefined}>
                {row.values.slice(0, 4).map((value, index) => (
                  <td
                    key={index}
                    className={`max-w-0 truncate px-1.5 py-[1px] font-mono text-[10px] leading-[15px] text-text-primary ${
                      ROLE_CELL_CLASSES[role]
                    }`}
                  >
                    <Value value={value} />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function CountBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 text-[9.5px] font-medium tabular-nums text-text-secondary">
      {children}
    </span>
  )
}

function ExpandButton({
  expanded,
  onClick,
}: {
  expanded: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={expanded ? 'Collapse preview' : 'Expand preview'}
      aria-label={expanded ? 'Collapse preview' : 'Expand preview'}
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="ml-auto shrink-0 rounded-md p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      {expanded ? (
        <ChevronUp className="size-3.5" aria-hidden />
      ) : (
        <ChevronDown className="size-3.5" aria-hidden />
      )}
    </button>
  )
}

/** Wrapper giving every node the same interaction + positioning. */
function NodeFrame({
  node,
  status,
  selected,
  expanded,
  extraClass,
  ariaLabel,
  onSelect,
  children,
}: {
  node: FlowGraphNode
  status: FlowElementStatus
  selected: boolean
  expanded: boolean
  extraClass?: string
  ariaLabel: string
  onSelect: (node: FlowGraphNode) => void
  children: React.ReactNode
}) {
  if (status === 'hidden') return null
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={selected}
      title={node.hint !== undefined ? `${node.label} — ${node.hint}` : node.label}
      onClick={() => onSelect(node)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(node)
        }
      }}
      className={`flow-node absolute cursor-pointer rounded-xl border text-left shadow-sm transition-[border-color,box-shadow,background-color,opacity] duration-200 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
        STATUS_RING[status]
      } ${selected ? 'ring-2 ring-accent' : ''} ${extraClass ?? ''}`}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: expanded ? node.height + (EXPANDED_ROWS - PREVIEW_ROWS) * 17 : node.height,
        zIndex: expanded ? 30 : selected ? 20 : 1,
        animation: 'flow-node-in 220ms ease-out',
      }}
    >
      {children}
    </div>
  )
}

interface FlowNodeViewProps {
  node: FlowGraphNode
  status: FlowElementStatus
  selected: boolean
  expanded: boolean
  onSelect: (node: FlowGraphNode) => void
  onToggleExpand: (nodeId: string) => void
}

export function FlowNodeView({
  node,
  status,
  selected,
  expanded,
  onSelect,
  onToggleExpand,
}: FlowNodeViewProps) {
  const limit = expanded ? EXPANDED_ROWS : PREVIEW_ROWS
  const toggle = (): void => onToggleExpand(node.id)

  if (node.kind === 'source') {
    const table = node.table
    if (!table) return null
    const expandable = table.previewRows.length > PREVIEW_ROWS
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={expanded}
        extraClass={table.role === 'join' ? 'border-purple/40' : 'border-border'}
        ariaLabel={`Source table ${node.label}, ${table.rowCount} rows`}
        onSelect={onSelect}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-xl p-2.5">
          <div className="flex items-center gap-2">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
                table.role === 'join' ? 'bg-purple/15 text-purple' : 'bg-accent-soft text-accent'
              }`}
            >
              <Database className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12.5px] font-semibold text-text-primary">
                  {node.label}
                </span>
                {table.role === 'join' && (
                  <span className="shrink-0 rounded bg-purple/15 px-1 py-px text-[8.5px] font-medium text-purple uppercase">
                    {table.joinType?.replace(' JOIN', '')}
                  </span>
                )}
              </div>
              <div className="truncate text-[9.5px] text-text-muted">
                {table.role === 'from' ? 'FROM' : 'join input'}
                {table.alias !== null ? ` · alias ${table.alias}` : ''} · {table.rowCount} row
                {table.rowCount === 1 ? '' : 's'}
              </div>
            </div>
            {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
          </div>
          <MiniPreview columns={table.columns} rows={table.previewRows} limit={limit} />
        </div>
      </NodeFrame>
    )
  }

  if (node.kind === 'operation') {
    const snapshot = node.snapshot
    const StageIcon = STAGE_ICONS[node.stage ?? 'SELECT'] ?? ArrowRight
    const accent = STAGE_ACCENT[node.stage ?? 'SELECT'] ?? 'text-text-secondary'
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={false}
        extraClass="overflow-hidden"
        ariaLabel={`Operation ${node.label}: ${node.detail ?? ''}`}
        onSelect={onSelect}
      >
        <div className={`flex h-full items-stretch bg-surface`}>
          <span className={`w-1 shrink-0 bg-current opacity-80 ${accent}`} aria-hidden />
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <StageIcon className={`size-3.5 shrink-0 ${accent}`} aria-hidden />
              <span className="truncate text-[11px] font-semibold tracking-wide text-text-primary uppercase">
                {node.label}
              </span>
              {status === 'active' && (
                <span className="ml-auto flex items-center gap-1 text-[9px] font-medium text-accent">
                  <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
                  running
                </span>
              )}
              {snapshot !== undefined && status === 'completed' && (
                <span className="ml-auto shrink-0 text-[9px] tabular-nums text-text-muted">
                  {snapshot.inputRowCount} → {snapshot.outputRowCount}
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[9.5px] leading-tight text-text-secondary">
              {node.detail}
            </div>
            {node.hint !== undefined && (
              <div className="truncate text-[9px] leading-tight text-text-muted">{node.hint}</div>
            )}
          </div>
        </div>
      </NodeFrame>
    )
  }

  if (node.kind === 'data') {
    const snapshot = node.snapshot
    if (!snapshot) return null
    const expandable = snapshot.rows.length > PREVIEW_ROWS
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={expanded}
        extraClass="border-border"
        ariaLabel={`Intermediate result after ${node.stage}, ${snapshot.outputRowCount} rows`}
        onSelect={onSelect}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-xl p-2.5">
          <div className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-text-secondary">
              <Table2 className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11.5px] font-medium text-text-primary">
                {node.label}
              </div>
              <div className="truncate text-[9.5px] tabular-nums text-text-muted">
                {node.detail}
              </div>
            </div>
            {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
            {!expandable && <CountBadge>{snapshot.outputRowCount}</CountBadge>}
          </div>
          <MiniPreview
            columns={snapshot.columns}
            rows={snapshot.rows}
            roles={snapshot.roles}
            limit={limit}
          />
        </div>
      </NodeFrame>
    )
  }

  if (node.kind === 'branch') {
    const snapshot = node.snapshot
    if (!snapshot) return null
    const expandable = (node.removedRows?.length ?? 0) > PREVIEW_ROWS
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={expanded}
        extraClass="border-dashed border-danger/50 bg-danger-soft/30"
        ariaLabel={`${node.label} — removed records`}
        onSelect={onSelect}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-xl p-2.5">
          <div className="flex items-start gap-1.5">
            <Filter className="mt-px size-3.5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-semibold text-danger">{node.label}</div>
              <div className="line-clamp-1 text-[9.5px] leading-tight text-text-muted">
                {node.hint ?? 'These rows did not continue.'}
              </div>
            </div>
            {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
          </div>
          {expanded && node.removedRows !== undefined && (
            <MiniPreview
              columns={snapshot.columns}
              rows={node.removedRows}
              roles={snapshot.roles}
              limit={limit}
            />
          )}
        </div>
      </NodeFrame>
    )
  }

  if (node.kind === 'group') {
    const aggregates = Object.entries(node.group?.aggregates ?? {})
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={false}
        extraClass="border-purple/40 bg-purple/10"
        ariaLabel={`Group ${node.label}: ${node.detail ?? ''}`}
        onSelect={onSelect}
      >
        <div className="flex h-full flex-col justify-center gap-0.5 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5">
            <Layers className="size-3 shrink-0 text-purple" aria-hidden />
            <span className="truncate font-mono text-[10.5px] font-semibold text-purple">
              {node.label}
            </span>
          </div>
          <div className="flex items-center gap-1.5 overflow-hidden">
            <span className="truncate text-[9.5px] text-text-secondary">{node.detail}</span>
            {aggregates.length > 0 && (
              <span className="ml-auto shrink-0 rounded bg-surface/70 px-1 font-mono text-[9px] text-text-secondary">
                {aggregates
                  .slice(0, 2)
                  .map(([name, value]) => `${name}=${value === null ? 'NULL' : String(value)}`)
                  .join(' ')}
              </span>
            )}
          </div>
        </div>
      </NodeFrame>
    )
  }

  // final
  const finished = status === 'completed'
  const rows = node.rows ?? []
  const expandable = finished && rows.length > PREVIEW_ROWS
  const columns = node.snapshot?.columns ?? []
  return (
    <NodeFrame
      node={node}
      status={status}
      selected={selected}
      expanded={expanded}
      extraClass="border-accent/60 bg-surface"
      ariaLabel={finished ? 'Final result' : 'Final result (pending)'}
      onSelect={onSelect}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-xl p-2.5">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Sparkles className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-text-primary">Final result</div>
            <div className="truncate text-[9.5px] text-text-muted">
              {finished ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : 'waiting for playback'}
            </div>
          </div>
          {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
          {finished && !expandable && <CountBadge>{rows.length}</CountBadge>}
        </div>
        {finished ? (
          <MiniPreview columns={columns} rows={rows} limit={limit} />
        ) : (
          <div className="mt-1 flex flex-1 items-center justify-center rounded-md border border-dashed border-border px-2 py-2 text-[10px] text-text-muted">
            not produced yet
          </div>
        )}
      </div>
    </NodeFrame>
  )
}
