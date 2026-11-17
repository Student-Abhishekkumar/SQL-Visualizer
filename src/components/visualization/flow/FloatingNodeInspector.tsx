import { useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Maximize2,
  Minimize2,
  Minus,
  X,
} from 'lucide-react'
import { RowTable } from '../RowTable'
import { Tooltip } from '../../common/Tooltip'
import {
  inspectNode,
  type InspectionTable,
} from '../../../services/visualization/nodeInspection'
import {
  clampPosition,
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
import { accentColor, nodeAccentKey } from './nodeAccent'

/**
 * Floating Node Inspector — a draggable, resizable data-inspection
 * window that opens over the flow canvas when a node is selected.
 *
 * All content is resolved from the immutable trace by
 * `inspectNode`; this component owns only presentation and the
 * window interaction model (drag, eight-way resize, maximize).
 *
 * The window has three explicit modes, owned by the workspace so they
 * survive node switches and playback updates:
 *  - `expanded`  — the full draggable/resizable window
 *  - `collapsed` — header-only, with the content removed from the layout
 *  - `minimized` — hidden completely, represented by the inspector dock
 *
 * Geometry is also workspace-owned: the popup never stores its own
 * position or size, so switching nodes, collapsing and restoring cannot
 * lose the last full rectangle.
 */

/** Height of the title bar; also the height of the header-only window. */
export const INSPECTOR_HEADER_HEIGHT = 52
const PAGE_SIZE = 25

export type InspectorWindowMode = 'expanded' | 'collapsed' | 'minimized'

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

const STATUS_DOT: Record<FlowElementStatus, string> = {
  pending: 'bg-text-muted/50',
  active: 'bg-accent animate-pulse',
  completed: 'bg-success',
  hidden: 'bg-text-muted/40',
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
  /** Current window mode (expanded, header-only or docked). */
  mode: InspectorWindowMode
  onModeChange: (mode: InspectorWindowMode) => void
  onRectChange: (rect: WindowRect) => void
  onClose: () => void
}

interface InteractionState {
  kind: 'move' | 'resize'
  edge: ResizeEdge | null
  pointerId: number
  startX: number
  startY: number
  /** The currently visible rectangle (header-only when collapsed). */
  startRect: WindowRect
  /** Saved expanded height, so a collapsed drag never overwrites it. */
  expandedHeight: number
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
    <div className="node-inspector-table space-y-1.5">
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
          <span className="tabular-nums">
            Rows {start + 1}–{start + rows.length} of {table.rows.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous rows"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary disabled:opacity-40"
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
              className="rounded p-1 text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary disabled:opacity-40"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border bg-surface-2/40 px-3 py-5 text-center text-[11px] leading-relaxed text-text-muted"
    >
      {children}
    </div>
  )
}

function IconControl({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string
  onClick: () => void
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClick}
        className={`inline-flex size-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none ${
          pressed === true ? 'bg-surface-3 text-text-primary' : ''
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function FloatingNodeInspector({
  node,
  trace,
  status,
  revealed = true,
  rect,
  bounds,
  mode,
  onModeChange,
  onRectChange,
  onClose,
}: FloatingNodeInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [maximized, setMaximized] = useState(false)
  // In-flight drag/resize rectangle. Kept local so a pointermove only
  // re-renders this popup, never the workspace/canvas under it; the result
  // is committed to the workspace-owned rect once the gesture ends.
  const [liveRect, setLiveRect] = useState<WindowRect | null>(null)
  const interactionRef = useRef<InteractionState | null>(null)

  const inspection = useMemo(() => inspectNode(node, trace), [node, trace])
  const inspectionStatus = status ?? 'pending'
  const accent = accentColor(nodeAccentKey(node))

  const collapsed = mode === 'collapsed'
  const minimized = mode === 'minimized'
  const fullRect = useMemo(() => maximizeRect(bounds), [bounds])
  // `rect` is the saved expanded geometry. The visible rectangle is
  // derived from it: collapsed mode keeps the width/position but its real
  // height is the header, so no invisible expanded area survives. The
  // visible rectangle is clamped itself, so a saved position from the
  // other mode can never place content outside the workspace.
  const baseRect = maximized ? fullRect : (liveRect ?? rect)
  const displayRect: WindowRect = clampPosition(
    collapsed ? { ...baseRect, height: INSPECTOR_HEADER_HEIGHT } : baseRect,
    bounds,
  )

  const beginInteraction = (
    kind: InteractionState['kind'],
    edge: ResizeEdge | null,
    event: React.PointerEvent<HTMLElement>,
  ): void => {
    // Only a maximized window refuses to move: it is pinned to the
    // workspace. A collapsed window is still a real header bar, so it
    // must remain draggable exactly like the expanded window.
    if (kind === 'move' && maximized) return
    event.preventDefault()
    event.stopPropagation()
    // Drag against the CURRENT visible box. Collapsed mode must clamp
    // using the header height, never the saved expanded height.
    interactionRef.current = {
      kind,
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: displayRect,
      expandedHeight: baseRect.height,
      lastRect: displayRect,
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
      // Moving a collapsed window changes only its position: commit the
      // saved expanded height so expanding restores the exact size.
      const committed =
        collapsed && interaction.kind === 'move'
          ? { ...interaction.lastRect, height: interaction.expandedHeight }
          : interaction.lastRect
      onRectChange(committed)
    }
    try {
      event.currentTarget.releasePointerCapture?.(interaction.pointerId)
    } catch {
      // Capture may already be released by the browser.
    }
  }

  const toggleMaximized = (): void => {
    if (collapsed) onModeChange('expanded')
    setMaximized((value) => !value)
  }

  const { details } = inspection
  const showHandles = !collapsed && !maximized
  const outputDeferred = node.kind === 'final' && !revealed
  const interacting = liveRect !== null

  return (
    <div
      role="dialog"
      aria-label="Node inspector"
      aria-modal={false}
      aria-hidden={minimized || undefined}
      data-node-id={node.id}
      data-mode={mode}
      data-maximized={maximized ? 'true' : undefined}
      className={`node-inspector absolute z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/25 ring-1 ring-black/5 ${
        interacting ? '' : 'transition-[height] duration-200 ease-out motion-reduce:transition-none'
      }`}
      style={
        {
          left: displayRect.x,
          top: displayRect.y,
          width: displayRect.width,
          height: displayRect.height,
          display: minimized ? 'none' : undefined,
          '--inspector-accent': accent,
        } as React.CSSProperties
      }
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header
        data-testid="node-inspector-header"
        onPointerDown={(event) => beginInteraction('move', null, event)}
        onPointerMove={handleInteractionMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        className={`node-inspector-header flex shrink-0 items-center gap-2 border-b border-border px-3 ${
          maximized ? '' : 'cursor-move'
        }`}
        style={{ height: INSPECTOR_HEADER_HEIGHT }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="node-inspector-badge shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.08em] uppercase">
              {inspection.header.badge}
            </span>
            <span
              className="truncate text-[12.5px] font-semibold tracking-tight text-text-primary"
              title={inspection.header.title}
            >
              {inspection.header.title}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[10px] text-text-muted">
            <span className="truncate font-mono">{inspection.header.operation}</span>
            {inspection.header.blockLabel !== undefined && (
              <span className="truncate" title={inspection.header.blockLabel}>
                {inspection.header.blockLabel}
              </span>
            )}
            {status !== undefined && (
              <span
                data-testid="node-inspector-status"
                className="inline-flex shrink-0 items-center gap-1.5"
              >
                <span
                  className={`size-1.5 rounded-full ${STATUS_DOT[inspectionStatus]}`}
                  aria-hidden
                />
                {STATUS_TEXT[status]}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconControl
            label={collapsed ? 'Expand node inspector' : 'Collapse node inspector'}
            pressed={collapsed}
            onClick={() => onModeChange(collapsed ? 'expanded' : 'collapsed')}
          >
            {collapsed ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronUp className="size-3.5" aria-hidden />
            )}
          </IconControl>
          <IconControl
            label="Minimize node inspector"
            onClick={() => onModeChange('minimized')}
          >
            <Minus className="size-3.5" aria-hidden />
          </IconControl>
          <IconControl
            label={maximized ? 'Restore node inspector size' : 'Maximize node inspector'}
            pressed={maximized}
            onClick={toggleMaximized}
          >
            {maximized ? (
              <Minimize2 className="size-3.5" aria-hidden />
            ) : (
              <Maximize2 className="size-3.5" aria-hidden />
            )}
          </IconControl>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <IconControl label="Close node inspector" onClick={onClose}>
            <X className="size-3.5" aria-hidden />
          </IconControl>
        </div>
      </header>

      {!collapsed && (
        <>
          <div
            role="tablist"
            aria-label="Inspector sections"
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface-2/60 px-2 py-1.5"
          >
            {TABS.map((entry) => (
              <button
                key={entry.id}
                role="tab"
                id={`inspector-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`inspector-panel-${entry.id}`}
                onClick={() => setTab(entry.id)}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  tab === entry.id
                    ? 'bg-surface text-text-primary shadow-sm ring-1 ring-border'
                    : 'text-text-muted hover:bg-surface-3/60 hover:text-text-secondary'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`inspector-panel-${tab}`}
            aria-labelledby={`inspector-tab-${tab}`}
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
                    <div className="rounded-lg border border-border/70 bg-surface-2 px-2.5 py-2">
                      <dt className="text-[9px] tracking-wide text-text-muted uppercase">rows in</dt>
                      <dd className="mt-0.5 font-mono text-[15px] leading-none text-text-primary">
                        {inspection.overview.inputRows ?? '—'}
                      </dd>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-surface-2 px-2.5 py-2">
                      <dt className="text-[9px] tracking-wide text-text-muted uppercase">
                        rows out
                      </dt>
                      <dd className="mt-0.5 font-mono text-[15px] leading-none text-text-primary">
                        {inspection.overview.outputRows ?? '—'}
                      </dd>
                    </div>
                  </dl>
                </Section>
                <Section title="Execution status">
                  <p className="text-xs leading-relaxed text-text-secondary">
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
                  <dl className="space-y-1.5 text-[11px]">
                    <DetailRow label="Stage" value={inspection.header.stage ?? 'OUTPUT'} />
                    <DetailRow
                      label="Query block"
                      value={inspection.header.blockLabel ?? 'Outer query'}
                    />
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
                          className="rounded border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
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
