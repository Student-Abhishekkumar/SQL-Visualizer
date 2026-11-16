import { memo } from 'react'
import {
  ArrowDownUp,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Database,
  Filter,
  FilterX,
  Gauge,
  GitMerge,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Table2,
} from 'lucide-react'
import type { FlowElementStatus, FlowGraphNode, FlowSocket } from '../../../types/flowGraph'
import type { RowRole, VisualizedStage } from '../../../types/visualization'
import { nodeDisplayHeight, socketOffset } from '../../../services/visualization/flowGeometry'
import { nodeAccentKey } from './nodeAccent'

/**
 * Renders one flow-graph node as a compact Blender-inspired module:
 * tinted title bar, real data body, circular sockets on the exact
 * geometric ports used by the wire router, and a tiny status orb.
 *
 * Every displayed value comes from real snapshots / source-table
 * metadata — previews are genuine rows. Nodes remain keyboard-accessible
 * (role="button" + Enter/Space) so the preview expand control can be a
 * real nested <button>.
 */

const ROLE_CELL_CLASSES: Record<RowRole, string> = {
  unchanged: '',
  accepted: 'text-success',
  filtered: 'text-danger line-through opacity-70',
  duplicated: 'text-warning line-through opacity-70',
  selected: 'text-accent font-medium',
  skipped: 'text-text-muted line-through opacity-70',
  grouped: 'text-purple',
}

const STAGE_ICONS: Partial<Record<VisualizedStage, typeof Filter>> = {
  JOIN: GitMerge,
  WHERE: Filter,
  GROUP_BY: Boxes,
  HAVING: SlidersHorizontal,
  SELECT: Scissors,
  DISTINCT: Sparkles,
  ORDER_BY: ArrowDownUp,
  LIMIT: Gauge,
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
    return <div className="flow-empty">no rows</div>
  }
  return (
    <div className="flow-preview">
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            {columns.slice(0, 4).map((column, index) => (
              <th key={`${column}-${index}`} title={column}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.map((row) => {
            const role = roles?.[row.id] ?? 'unchanged'
            return (
              <tr key={row.id}>
                {row.values.slice(0, 4).map((value, index) => (
                  <td key={index} className={`max-w-0 truncate ${ROLE_CELL_CLASSES[role]}`}>
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
  return <span className="flow-count-badge">{children}</span>
}

function StatusOrb({ status }: { status: FlowElementStatus }) {
  if (status === 'active') {
    return (
      <span className="flow-status flow-status-active" title="running" aria-hidden>
        <span />
      </span>
    )
  }
  if (status === 'completed') {
    return (
      <span className="flow-status flow-status-completed" title="completed" aria-hidden>
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  return <span className="flow-status flow-status-pending" title="pending" aria-hidden />
}

function ExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
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
      onKeyDown={(event) => {
        // Keep Space/Enter on the preview control from also selecting the node.
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      }}
      className="flow-icon-button focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
    >
      {expanded ? (
        <ChevronUp className="size-3" aria-hidden />
      ) : (
        <ChevronDown className="size-3" aria-hidden />
      )}
    </button>
  )
}

function NodeHeader({
  icon: Icon,
  title,
  badge,
  status,
  unsupported,
  children,
}: {
  icon: typeof Filter
  title: string
  badge?: string
  status: FlowElementStatus
  unsupported?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className="flow-node-header">
      <Icon className="flow-node-icon" aria-hidden />
      <span className="flow-node-title" title={title}>
        {title}
      </span>
      {badge !== undefined && <span className="flow-node-badge">{badge}</span>}
      {unsupported === true && (
        <span className="flow-node-unsupported" title="This stage cannot be visualized faithfully">
          <CircleAlert className="size-3" aria-hidden />
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {children}
        <StatusOrb status={status} />
      </span>
    </div>
  )
}

function SocketView({
  node,
  socket,
  displayHeight,
}: {
  node: FlowGraphNode
  socket: FlowSocket
  displayHeight: number
}) {
  const offset = socketOffset(node, socket, displayHeight)
  const labelPosition =
    socket.side === 'left'
      ? { left: offset.x - 7, top: offset.y }
      : socket.side === 'right'
        ? { left: offset.x + 7, top: offset.y }
        : socket.side === 'top'
          ? { left: offset.x + 7, top: offset.y - 3 }
          : { left: offset.x + 7, top: offset.y + 3 }
  const title = `${socket.direction === 'input' ? 'Input' : 'Output'} ${
    socket.kind === 'branch' ? 'branch' : 'data'
  } socket${socket.label !== undefined ? ` · ${socket.label}` : ''}`
  return (
    <>
      <span
        aria-hidden
        className="flow-socket"
        data-direction={socket.direction}
        data-kind={socket.kind}
        title={title}
        style={{ left: offset.x, top: offset.y }}
      />
      {socket.label !== undefined && (
        <span
          aria-hidden
          className="flow-socket-label"
          data-side={socket.side}
          data-kind={socket.kind}
          style={labelPosition}
        >
          {socket.label}
        </span>
      )}
    </>
  )
}

/** Wrapper giving every node the same interaction, ports and positioning. */
function NodeFrame({
  node,
  status,
  selected,
  expanded,
  offsetX,
  offsetY,
  ariaLabel,
  onSelect,
  onHover,
  children,
}: {
  node: FlowGraphNode
  status: FlowElementStatus
  selected: boolean
  expanded: boolean
  /** Live horizontal offset applied while the user drags the node. */
  offsetX: number
  /** Live vertical offset applied when a neighbouring preview expands. */
  offsetY: number
  ariaLabel: string
  onSelect: (node: FlowGraphNode) => void
  onHover?: (nodeId: string | null) => void
  children: React.ReactNode
}) {
  if (status === 'hidden') return null
  const displayHeight = nodeDisplayHeight(node, expanded)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={selected}
      title={node.hint !== undefined ? `${node.label} — ${node.hint}` : node.label}
      data-accent={nodeAccentKey(node)}
      data-node-id={node.id}
      data-kind={node.kind}
      data-status={status}
      data-selected={selected ? 'true' : undefined}
      data-expanded={expanded ? 'true' : undefined}
      data-unsupported={node.unsupported === true ? 'true' : undefined}
      onClick={() => onSelect(node)}
      onPointerEnter={() => onHover?.(node.id)}
      onPointerLeave={() => onHover?.(null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(node)
        }
      }}
      className="flow-node absolute cursor-pointer text-left focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      style={{
        left: node.x + offsetX,
        top: node.y + offsetY,
        width: node.width,
        height: displayHeight,
        zIndex: expanded ? 30 : selected ? 20 : 1,
      }}
    >
      {node.sockets.map((socket) => (
        <SocketView
          key={socket.id}
          node={node}
          socket={socket}
          displayHeight={displayHeight}
        />
      ))}
      {children}
    </div>
  )
}

interface FlowNodeViewProps {
  node: FlowGraphNode
  status: FlowElementStatus
  selected: boolean
  expanded: boolean
  /** Horizontal offset applied while the user drags this node. */
  offsetX?: number
  /** Vertical offset applied when an earlier preview pushes this node down. */
  offsetY?: number
  onSelect: (node: FlowGraphNode) => void
  /** Emphasize the wires connected to this node while hovered. */
  onHover?: (nodeId: string | null) => void
  onToggleExpand: (nodeId: string) => void
}

export const FlowNodeView = memo(function FlowNodeView({
  node,
  status,
  selected,
  expanded,
  offsetX = 0,
  offsetY = 0,
  onSelect,
  onHover,
  onToggleExpand,
}: FlowNodeViewProps) {
  const limit = expanded ? EXPANDED_ROWS : PREVIEW_ROWS
  const toggle = (): void => onToggleExpand(node.id)

  if (node.kind === 'source') {
    const table = node.table
    if (!table) return null
    const expandable = table.previewRows.length > PREVIEW_ROWS
    const extraColumns = Math.max(0, table.columns.length - 4)
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={expanded}
        offsetX={offsetX}
        offsetY={offsetY}
        ariaLabel={`Source table ${node.label}, ${table.rowCount} rows`}
        onSelect={onSelect}
        onHover={onHover}
      >
        <div className="flow-node-surface">
          <NodeHeader
            icon={Database}
            title={node.label}
            badge={table.role === 'from' ? 'FROM' : (table.joinType?.replace(' JOIN', '') ?? 'JOIN')}
            status={status}
            unsupported={node.unsupported}
          >
            {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
          </NodeHeader>
          <div className="flow-node-body">
            <div className="flow-meta-row">
              <CountBadge>
                {table.rowCount} row{table.rowCount === 1 ? '' : 's'}
              </CountBadge>
              <span className="flow-meta-text truncate">
                {table.alias !== null ? `alias ${table.alias}` : 'source table'}
              </span>
            </div>
            <div className="flow-column-list" title={table.columns.join(', ')}>
              {table.columns.slice(0, 4).map((column) => (
                <span key={column} className="flow-column-chip">
                  {column}
                </span>
              ))}
              {extraColumns > 0 && <span className="flow-column-chip">+{extraColumns}</span>}
              {table.columns.length === 0 && <span className="flow-column-chip">no columns</span>}
            </div>
            <MiniPreview columns={table.columns} rows={table.previewRows} limit={limit} />
          </div>
        </div>
      </NodeFrame>
    )
  }

  if (node.kind === 'operation') {
    const snapshot = node.snapshot
    const StageIcon = STAGE_ICONS[node.stage ?? 'SELECT'] ?? ArrowRight
    return (
      <NodeFrame
        node={node}
        status={status}
        selected={selected}
        expanded={false}
        offsetX={offsetX}
        offsetY={offsetY}
        ariaLabel={`Operation ${node.label}: ${node.detail ?? ''}`}
        onSelect={onSelect}
        onHover={onHover}
      >
        <div className="flow-node-surface">
          <NodeHeader
            icon={StageIcon}
            title={node.label}
            status={status}
            unsupported={node.unsupported}
          >
            {snapshot !== undefined && status === 'completed' && (
              <span className="flow-op-count">
                {snapshot.inputRowCount} → {snapshot.outputRowCount}
              </span>
            )}
          </NodeHeader>
          <div className="flow-node-body flow-op-body">
            <div className="flow-op-detail" title={node.detail}>
              {node.detail}
            </div>
            <div className="flow-hint" title={node.hint}>
              {node.hint}
            </div>
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
        offsetX={offsetX}
        offsetY={offsetY}
        ariaLabel={`Intermediate result after ${node.stage}, ${snapshot.outputRowCount} rows`}
        onSelect={onSelect}
        onHover={onHover}
      >
        <div className="flow-node-surface">
          <NodeHeader
            icon={Table2}
            title={node.label}
            badge={node.stage?.replace('_', ' ')}
            status={status}
            unsupported={node.unsupported}
          >
            <CountBadge>{snapshot.outputRowCount}</CountBadge>
            {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
          </NodeHeader>
          <div className="flow-node-body">
            <div className="flow-meta-row">
              <span className="flow-meta-text tabular-nums">
                {snapshot.inputRowCount} in → {snapshot.outputRowCount} out
              </span>
            </div>
            <MiniPreview
              columns={snapshot.columns}
              rows={snapshot.rows}
              roles={snapshot.roles}
              limit={limit}
            />
          </div>
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
        offsetX={offsetX}
        offsetY={offsetY}
        ariaLabel={`${node.label} — removed records`}
        onSelect={onSelect}
        onHover={onHover}
      >
        <div className="flow-node-surface">
          <NodeHeader
            icon={FilterX}
            title={node.label}
            badge="removed"
            status={status}
            unsupported={node.unsupported}
          >
            <CountBadge>{node.removedRows?.length ?? 0}</CountBadge>
            {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
          </NodeHeader>
          <div className="flow-node-body">
            <div className="flow-hint" title={node.hint}>
              {node.hint ?? 'These rows did not continue.'}
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
        offsetX={offsetX}
        offsetY={offsetY}
        ariaLabel={`Group ${node.label}: ${node.detail ?? ''}`}
        onSelect={onSelect}
        onHover={onHover}
      >
        <div className="flow-node-surface">
          <NodeHeader
            icon={Boxes}
            title={node.label}
            badge="group"
            status={status}
            unsupported={node.unsupported}
          >
            {node.group !== undefined && <CountBadge>{node.group.rowIds.length}</CountBadge>}
          </NodeHeader>
          <div className="flow-node-body flow-group-body">
            <span className="flow-hint truncate">{node.detail}</span>
            {aggregates.length > 0 && (
              <span className="flow-group-aggregate truncate" title={aggregates.map(([name, value]) => `${name}=${value === null ? 'NULL' : String(value)}`).join(' ')}>
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
      offsetX={offsetX}
      offsetY={offsetY}
      ariaLabel={finished ? 'Final result' : 'Final result (pending)'}
      onSelect={onSelect}
      onHover={onHover}
    >
      <div className="flow-node-surface">
        <NodeHeader icon={Sparkles} title="Final result" badge="OUTPUT" status={status}>
          {finished && <CountBadge>{rows.length}</CountBadge>}
          {expandable && <ExpandButton expanded={expanded} onClick={toggle} />}
        </NodeHeader>
        <div className="flow-node-body">
          <div className="flow-meta-row">
            <span className="flow-meta-text truncate">
              {finished
                ? `${rows.length} row${rows.length === 1 ? '' : 's'} returned by the query`
                : 'waiting for playback'}
            </span>
          </div>
          {finished ? (
            <MiniPreview columns={columns} rows={rows} limit={limit} />
          ) : (
            <div className="flow-empty">not produced yet</div>
          )}
        </div>
      </div>
    </NodeFrame>
  )
})
