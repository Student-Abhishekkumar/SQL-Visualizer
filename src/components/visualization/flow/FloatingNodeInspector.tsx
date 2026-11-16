import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react'
import { RowTable } from '../RowTable'
import {
  inspectNode,
  type InspectionTable,
} from '../../../services/visualization/nodeInspection'
import {
  maximizeRect,
  moveRect,
  resizeRect,
  RESIZE_CURSORS,
  RESIZE_EDGES,
  type ResizeEdge,
  type WindowBounds,
  type WindowRect,
} from '../../../services/visualization/floatingWindow'
import type { FlowElementStatus, FlowGraphNode } from '../../../types/flowGraph'
import type { VisualizationTrace } from '../../../types/visualization'

/**
 * Floating Node Inspector — a draggable, resizable data-inspection
 * window that opens over the flow canvas when a node is selected.
 *
 * All content is resolved from the immutable trace by
 * `inspectNode`; this component owns only presentation and the
 * window interaction model (drag, eight-way resize, minimize/restore).
 * Geometry is owned by the workspace so position and size survive
 * switching nodes, closing and reopening, and playback updates.
 */

const HEADER_HEIGHT = 48
const PAGE_SIZE = 25

type InspectorTab = 'overview' | 'input' | 'output' | 'details'

const TABS: readonly { id: InspectorTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'input', label: 'Input' },
  { id: 'output', label: 'Output' },
  { id: 'details', label: 'Details' },
]

const STATUS_TEXT: Record<FlowElementStatus, string> = {
  pending: 'pending',
  active: 'running',
  completed: 'completed',
  hidden: 'not available yet',
}

interface FloatingNodeInspectorProps {
  node: FlowGraphNode
  trace: VisualizationTrace
  /** Current playback status of the node, for the overview. */
  status?: FlowElementStatus
  /** False while the node's real data has not been produced yet. */
  revealed?: boolean
  /** Persisted window rectangle (clamped by the workspace). */
  rect: WindowRect
  /** Available workspace size, used to clamp drag/resize. */
  bounds: WindowBounds
  onRectChange: (rect: WindowRect) => void
  onClose: () => void
}

interface InteractionState {
  kind: 'move' | 'resize'
  edge: ResizeEdge | null
  pointerId: number
  startX: number
  startY: number
  startRect: WindowRect
  /** Latest rectangle of the gesture, committed on release. */
  lastRect: WindowRect
}

/** Paginated table so a capped 500-row snapshot stays responsive. */
function PaginatedTable({ table }: { table: InspectionTable }) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(table.rows.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const start = currentPage * PAGE_SIZE
  const rows = table.rows.slice(start, start + PAGE_SIZE)

  return (
    <div className="space-y-1.5">
      {table.label !== undefined && (
        <h4 className="text-[10px] font-semibold tracking-wide text-text-muted uppercase">
          {table.label}
        </h4>
      )}
      {table.note !== undefined && <p className="text-[10px] text-text-muted">{table.note}</p>}
      <RowTable
        columns={table.columns}
        rows={rows}
        roles={table.roles}
        startIndex={start}
        animate={false}
      />
      {table.rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-between text-[10px] text-text-muted">
          <span>
            Rows {start + 1}–{start + rows.length} of {table.rows.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous rows"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="rounded p-0.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </button>
            <span className="tabular-nums">
              {currentPage + 1}/{pageCount}
            </span>
            <button
              type="button"
              aria-label="Next rows"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
              className="rounded p-0.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-40"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold tracking-wide text-text-muted uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-text-muted">
      {children}
    </div>
  )
}

export function FloatingNodeInspector({
  node,
  trace,
  status,
  revealed = true,
  rect,
  bounds,
  onRectChange,
  onClose,
}: FloatingNodeInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [minimized, setMinimized] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // In-flight drag/resize rectangle. Kept local so a pointermove only
  // re-renders this popup, never the workspace/canvas under it; the result
  // is committed to the workspace-owned rect once the gesture ends.
  const [liveRect, setLiveRect] = useState<WindowRect | null>(null)
  const interactionRef = useRef<InteractionState | null>(null)

  const inspection = useMemo(() => inspectNode(node, trace), [node, trace])

  const fullRect = useMemo(() => maximizeRect(bounds), [bounds])
  const baseRect = maximized ? fullRect : (liveRect ?? rect)
  const displayRect: WindowRect = minimized ? { ...rect, height: HEADER_HEIGHT } : baseRect

  const beginInteraction = (
    kind: InteractionState['kind'],
    edge: ResizeEdge | null,
    event: React.PointerEvent<HTMLElement>,
  ): void => {
    if (kind === 'move' && maximized) return
    event.preventDefault()
    event.stopPropagation()
    interactionRef.current = {
      kind,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: baseRect,
      lastRect: baseRect,
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // jsdom and some browsers throw when capture is unsupported.
    }
  }

  const handleInteractionMove = (event: React.PointerEvent<HTMLElement>): void => {
    const interaction = interactionRef.current
    if (interaction === null || interaction.pointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const dx = event.clientX - interaction.startX
    const dy = event.clientY - interaction.startY
    const next =
      interaction.kind === 'move'
        ? moveRect(interaction.startRect, dx, dy, bounds)
        : resizeRect(interaction.startRect, interaction.edge ?? 'se', dx, dy, bounds)
    interaction.lastRect = next
    setLiveRect(next)
  }

  const endInteraction = (event: React.PointerEvent<HTMLElement>): void => {
    const interaction = interactionRef.current
    if (interaction === null) return
    interactionRef.current = null
    setLiveRect(null)
    if (interaction.lastRect !== interaction.startRect) {
      onRectChange(interaction.lastRect)
    }
    try {
      event.currentTarget.releasePointerCapture?.(interaction.pointerId)
    } catch {
      // Capture may already be released by the browser.
    }
  }

  const { details } = inspection
  const showHandles = !minimized && !maximized
  const outputDeferred = node.kind === 'final' && !revealed

  return (
    <div
      role="dialog"
      aria-label="Node inspector"
      aria-modal={false}
      data-node-id={node.id}
      data-maximized={maximized ? 'true' : undefined}
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/25 ring-1 ring-black/5"
      style={{
        left: displayRect.x,
        top: displayRect.y,
        width: displayRect.width,
        height: displayRect.height,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header
        data-testid="node-inspector-header"
        onPointerDown={(event) => beginInteraction('move', null, event)}
        onPointerMove={handleInteractionMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        className={`flex shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-3 ${
          maximized ? '' : 'cursor-move'
        }`}
        style={{ height: HEADER_HEIGHT }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-text-secondary uppercase">
              {inspection.header.badge}
            </span>
            <span
              className="truncate text-[12px] font-semibold text-text-primary"
              title={inspection.header.title}
            >
              {inspection.header.title}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-muted">
            <span className="truncate font-mono">{inspection.header.operation}</span>
            {status !== undefined && (
              <span data-testid="node-inspector-status">· {STATUS_TEXT[status]}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label={minimized ? 'Restore node inspector' : 'Minimize node inspector'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setMinimized((value) => !value)
            setMaximized(false)
          }}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
        >
          {minimized ? (
            <Maximize2 className="size-3.5" aria-hidden />
          ) : (
            <Minimize2 className="size-3.5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label={maximized ? 'Restore node inspector' : 'Maximize node inspector'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            setMaximized((value) => !value)
            setMinimized(false)
          }}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
        >
          <Maximize2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Close node inspector"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>

      {!minimized && (
        <>
          <div
            role="tablist"
            aria-label="Inspector sections"
            className="flex shrink-0 gap-0.5 border-b border-border bg-surface px-2 pt-1.5"
          >
            {TABS.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={`rounded-t-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                  tab === entry.id
                    ? 'border-b-2 border-accent text-text-primary'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
          >
            {tab === 'overview' && (
              <>
                <Section title="Operation">
                  <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-secondary">
                    {inspection.overview.description || 'No description available.'}
                  </p>
                </Section>
                <Section title="Rows">
                  <dl className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-border/70 bg-surface-2 px-2.5 py-1.5">
                      <dt className="text-[9px] tracking-wide text-text-muted uppercase">rows in</dt>
                      <dd className="font-mono text-sm text-text-primary">
                        {inspection.overview.inputRows ?? '—'}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-surface-2 px-2.5 py-1.5">
                      <dt className="text-[9px] tracking-wide text-text-muted uppercase">rows out</dt>
                      <dd className="font-mono text-sm text-text-primary">
                        {inspection.overview.outputRows ?? '—'}
                      </dd>
                    </div>
                  </dl>
                </Section>
                <Section title="Execution status">
                  <p className="text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">
                      {status !== undefined ? STATUS_TEXT[status] : 'unknown'}
                    </span>{' '}
                    {status === 'completed'
                      ? '— this stage has produced its real rows.'
                      : status === 'active'
                        ? '— this stage is running now.'
                        : status === 'pending'
                          ? '— playback has not reached this stage yet.'
                          : '— its data is not available at this position.'}
                  </p>
                </Section>
              </>
            )}

            {tab === 'input' &&
              (inspection.inputs.length === 0 ? (
                <Empty>
                  {node.kind === 'source'
                    ? 'This is a base table — it has no upstream input.'
                    : 'No input rows are available for this node.'}
                </Empty>
              ) : (
                inspection.inputs.map((table) => <PaginatedTable key={table.key} table={table} />)
              ))}

            {tab === 'output' &&
              (outputDeferred ? (
                <Empty>Not produced yet — run playback to this stage.</Empty>
              ) : inspection.output === null ? (
                <Empty>No output rows are available for this node.</Empty>
              ) : (
                <PaginatedTable table={inspection.output} />
              ))}

            {tab === 'details' && (
              <>
                <Section title="SQL operation">
                  <dl className="space-y-1 text-[11px]">
                    <DetailRow label="Stage" value={inspection.header.stage ?? 'OUTPUT'} />
                    <DetailRow label="Clause" value={details.clause} mono />
                  </dl>
                </Section>
                {details.filter !== null && details.filter !== details.clause && (
                  <Section title="Filter condition">
                    <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-text-secondary">
                      {details.filter}
                    </p>
                  </Section>
                )}
                {details.groupKeys.length > 0 && (
                  <Section title="Group keys">
                    <div className="flex flex-wrap gap-1.5">
                      {details.groupKeys.map((key) => (
                        <span
                          key={key}
                          className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                        >
                          {key}
                        </span>
                      ))}
                    </div>
                  </Section>
                )}
                {details.sort !== null && (
                  <Section title="Sort">
                    <p className="rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] text-text-secondary">
                      {details.sort}
                    </p>
                  </Section>
                )}
                {details.joins.length > 0 && (
                  <Section title="JOIN">
                    <ul className="space-y-1">
                      {details.joins.map((join) => (
                        <li
                          key={`${join.table}-${join.kind}`}
                          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11px] text-text-secondary"
                        >
                          <span className="font-medium text-text-primary">{join.kind}</span>{' '}
                          <span className="font-mono">{join.table}</span>
                          {join.on !== null && (
                            <span className="block font-mono text-[10px] text-text-muted">
                              ON {join.on}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                {(details.accepted !== null || details.rejected !== null) && (
                  <Section title="Records">
                    <div className="flex gap-2 text-[11px]">
                      {details.accepted !== null && (
                        <span className="rounded-lg border border-success/40 bg-success/10 px-2.5 py-1.5 text-success">
                          accepted: <span className="font-mono">{details.accepted}</span>
                        </span>
                      )}
                      {details.rejected !== null && (
                        <span className="rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-1.5 text-danger">
                          rejected: <span className="font-mono">{details.rejected}</span>
                        </span>
                      )}
                    </div>
                  </Section>
                )}
              </>
            )}
          </div>
        </>
      )}

      {showHandles &&
        RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            data-edge={edge}
            aria-hidden
            onPointerDown={(event) => beginInteraction('resize', edge, event)}
            onPointerMove={handleInteractionMove}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
            className="absolute touch-none"
            style={resizeHandleStyle(edge)}
          />
        ))}
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string | null
  mono?: boolean
}) {
  if (value === null) return null
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-text-muted">{label}</dt>
      <dd className={`min-w-0 flex-1 break-words text-text-secondary ${mono ? 'font-mono' : ''}`}>
        {value}
      </dd>
    </div>
  )
}

/** Inset handle geometry so no handle is clipped by the window border. */
function resizeHandleStyle(edge: ResizeEdge): React.CSSProperties {
  const size = edge.length === 2 ? 12 : 8
  const style: React.CSSProperties = {
    cursor: RESIZE_CURSORS[edge],
    zIndex: 2,
  }
  if (edge.includes('n')) style.top = 0
  if (edge.includes('s')) style.bottom = 0
  if (edge.includes('w')) style.left = 0
  if (edge.includes('e')) style.right = 0
  if (edge === 'n' || edge === 's') {
    style.left = 0
    style.right = 0
  }
  if (edge === 'e' || edge === 'w') {
    style.top = 0
    style.bottom = 0
  }
  if (edge.includes('n') || edge.includes('s')) style.height = size
  if (edge.includes('e') || edge.includes('w')) style.width = size
  if (edge.length === 2) {
    style.width = size
    style.height = size
  }
  return style
}
