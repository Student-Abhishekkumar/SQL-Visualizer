import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Database as DatabaseIcon,
  Eye,
  Info,
  Table2,
  TriangleAlert,
  Waypoints,
  X,
} from 'lucide-react'
import { motion } from 'motion/react'
import { PipelinePanel } from './PipelinePanel'
import { TransformationPanel } from './TransformationPanel'
import { ExplanationPanel } from './ExplanationPanel'
import { PlaybackControls } from './PlaybackControls'
import { ClauseStrip } from './ClauseStrip'
import { FlowView } from './flow/FlowView'
import { FloatingNodeInspector } from './flow/FloatingNodeInspector'
import { buildFlowGraph, deriveFlowState } from '../../services/visualization/graphBuilder'
import { mapQueryClauses, spanOfStage } from '../../services/visualization/clauseMapper'
import {
  clampRect,
  defaultRect,
  rectNearAnchor,
  type WindowBounds,
  type WindowRect,
} from '../../services/visualization/floatingWindow'
import { useVisualizationStore } from '../../store/visualizationStore'
import { useEditorStore } from '../../store/editorStore'
import type { StageSnapshot, VisualizedStage } from '../../types/visualization'

/**
 * The full visualization workspace: pipeline (left), Flow View
 * (default) or Table View (center), node inspector / explanation
 * (right) and playback controls (bottom). Both views share the same
 * playback controller, so switching modes never restarts playback.
 * Side panels collapse on narrow screens.
 */

interface VisualizationWorkspaceProps {
  queryName: string
  onClose: () => void
  /** Current editor SQL, used to flag stale visualizations. */
  currentQuery?: string
  /** Name of the active database, shown in the header. */
  activeDatabaseName?: string | null
  /** Re-run the visualization for the current editor SQL. */
  onRevisualize?: () => void
}

const STATUS_LABELS = {
  idle: 'No visualization yet',
  ready: 'Simulation ready',
  unsupported: 'Cannot visualize this query',
  unavailable: 'Database not ready',
} as const

export function VisualizationWorkspace({
  queryName,
  onClose,
  currentQuery,
  activeDatabaseName = null,
  onRevisualize,
}: VisualizationWorkspaceProps) {
  const trace = useVisualizationStore((state) => state.trace)
  const viewState = useVisualizationStore((state) => state.viewState)
  const playing = useVisualizationStore((state) => state.playing)
  const speed = useVisualizationStore((state) => state.speed)
  const finished = useVisualizationStore((state) => state.finished)
  const status = useVisualizationStore((state) => state.status)
  const unavailableReasons = useVisualizationStore((state) => state.unavailableReasons)
  const validation = useVisualizationStore((state) => state.validation)
  const actualRowCount = useVisualizationStore((state) => state.actualRowCount)

  const play = useVisualizationStore((state) => state.play)
  const pause = useVisualizationStore((state) => state.pause)
  const restart = useVisualizationStore((state) => state.restart)
  const next = useVisualizationStore((state) => state.next)
  const previous = useVisualizationStore((state) => state.previous)
  const seek = useVisualizationStore((state) => state.seek)
  const jumpToEnd = useVisualizationStore((state) => state.jumpToEnd)
  const seekToStage = useVisualizationStore((state) => state.seekToStage)
  const setSpeed = useVisualizationStore((state) => state.setSpeed)

  // Stage selected for inspection (persists until cleared or playback moves).
  const [inspectedStage, setInspectedStage] = useState<VisualizedStage | null>(null)
  // View mode: the animated flow canvas is the default; both views share playback.
  const [viewMode, setViewMode] = useState<'flow' | 'table'>('flow')
  // Narrow containers show the inspector/explanation as a drawer instead
  // of a permanent column, so the canvas keeps a usable width.
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Selected flow node id — resolved against the current graph, so a
  // stale id (new trace) simply resolves to nothing selected.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // Floating inspector geometry. Owned here (not by the popup) so position
  // and size survive switching nodes, closing/reopening and playback
  // updates for the lifetime of the workspace.
  const workspaceLayerRef = useRef<HTMLDivElement>(null)
  const [inspectorBounds, setInspectorBounds] = useState<WindowBounds>({ width: 0, height: 0 })
  const [inspectorRect, setInspectorRect] = useState<WindowRect | null>(null)

  const completedByStage = useMemo(() => {
    const map = new Map<VisualizedStage, StageSnapshot>()
    for (const snapshot of viewState.completedStages) {
      if (!map.has(snapshot.stage)) map.set(snapshot.stage, snapshot)
    }
    return map
  }, [viewState.completedStages])

  // The explanation/panel follows the inspected stage when set, else the
  // last completed snapshot of live playback.
  const liveSnapshot = viewState.snapshot
  const inspecting = inspectedStage !== null && completedByStage.has(inspectedStage)
  const displaySnapshot = inspecting
    ? (completedByStage.get(inspectedStage) ?? null)
    : liveSnapshot
  const displayStage = inspecting
    ? inspectedStage
    : (liveSnapshot?.stage ?? null)

  // The graph is derived from the immutable trace; node selection is
  // resolved against the same instance the canvas renders.
  const flowGraph = useMemo(() => (trace !== null ? buildFlowGraph(trace) : null), [trace])
  const selectedNode = useMemo(
    () => flowGraph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [flowGraph, selectedNodeId],
  )

  // One playback classification shared by the canvas and the inspector.
  const flowState = useMemo(() => {
    if (flowGraph === null) return null
    return deriveFlowState(
      flowGraph,
      new Set(viewState.completedStages.map((snapshot) => snapshot.stage)),
      viewState.activeStage,
      viewState.finished,
    )
  }, [flowGraph, viewState.completedStages, viewState.activeStage, viewState.finished])

  // The visible rectangle is always clamped into the measured workspace so
  // a viewport resize can never strand the popup off-screen.
  const inspectorDisplayRect =
    inspectorRect === null ? null : clampRect(inspectorRect, inspectorBounds)

  // Track the canvas layer size so the popup can be clamped into view.
  // Measurement runs from the observer/resize callbacks, never straight
  // from the effect body, to avoid cascading renders on mount.
  useEffect(() => {
    const element = workspaceLayerRef.current
    if (element === null) return
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      setInspectorBounds((previous) =>
        previous.width === box.width && previous.height === box.height
          ? previous
          : { width: box.width, height: box.height },
      )
    }
    window.addEventListener('resize', measure)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(element)
    }
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [status])

  // Clause spans of the visualized query, used by the strip and for
  // pushing the playback-synced highlight into the Monaco editor.
  const clauseSpans = useMemo(
    () => (trace !== null ? mapQueryClauses(trace.query) : []),
    [trace],
  )
  const seekableStages = useMemo(() => new Set(trace?.stages ?? []), [trace])

  // Synchronize the active stage with the external editor store: the
  // Monaco editor decorates the clause of the currently active stage
  // (or nothing when playback is idle/finished or the query changed).
  // A completed event leaves activeStage null; the clause the user is
  // looking at is then the stage that just completed.
  const setStageHighlight = useEditorStore((state) => state.setStageHighlight)
  const syncStage: VisualizedStage | null =
    viewState.activeStage ??
    (viewState.event?.type === 'STAGE_COMPLETED' ? (viewState.event.stage ?? null) : null)
  useEffect(() => {
    if (trace === null || syncStage === null) {
      setStageHighlight(null)
      return
    }
    const span = spanOfStage(clauseSpans, syncStage)
    setStageHighlight(
      span !== null ? { start: span.start, end: span.end, stage: syncStage } : null,
    )
  }, [syncStage, clauseSpans, trace, setStageHighlight])

  /**
   * First-open placement: prefer the space beside the clicked node, and
   * fall back to the workspace default when the node box is unavailable
   * (e.g. before layout has run).
   */
  const initialRectFor = (nodeId: string): WindowRect => {
    const layer = workspaceLayerRef.current
    const layerBox = layer?.getBoundingClientRect()
    if (layer === null || layerBox === undefined) {
      const empty = { width: 0, height: 0 }
      return rectNearAnchor(null, defaultRect(empty), empty)
    }
    const bounds: WindowBounds = { width: layerBox.width, height: layerBox.height }
    const base = defaultRect(bounds)
    const selector = `.flow-node[data-node-id="${nodeId.replace(/["\\]/g, '\\$&')}"]`
    const nodeElement = layer.querySelector<HTMLElement>(selector)
    if (nodeElement === null) return rectNearAnchor(null, base, bounds)
    const nodeBox = nodeElement.getBoundingClientRect()
    return rectNearAnchor(
      {
        x: nodeBox.left - layerBox.left,
        y: nodeBox.top - layerBox.top,
        width: nodeBox.width,
        height: nodeBox.height,
      },
      base,
      bounds,
    )
  }

  // Clicking a graph node selects it for inspection and traces its real
  // upstream data path. Selection is inspection-only: it never seeks the
  // timeline, re-runs SQL or changes playback. Seeking stays on the
  // clause strip, pipeline and timeline controls.
  const handleNodeSelect = (node: { stage: VisualizedStage | null; id: string }): void => {
    const deselecting = selectedNodeId === node.id
    setSelectedNodeId(deselecting ? null : node.id)
    if (deselecting) {
      // Clicking the selected node again only clears the inspection; the
      // current playback position is left untouched.
      setInspectedStage(null)
      return
    }
    if (inspectorRect === null) {
      setInspectorRect(initialRectFor(node.id))
    }
    // Do not force the details panel open: on narrow layouts it replaces
    // the canvas, which would hide the very upstream trace the click just
    // started. The Details toggle still opens the inspector for this node.
    // A node inspection must not leave an unrelated pinned stage behind.
    setInspectedStage(null)
    if (node.stage === null) {
      setStageHighlight(null)
      return
    }
    const span = spanOfStage(clauseSpans, node.stage)
    setStageHighlight(span !== null ? { start: span.start, end: span.end, stage: node.stage } : null)
  }

  if (status !== 'ready' || trace === null) {
    return (
      <section className="flex h-full flex-col overflow-hidden bg-surface">
        <WorkspaceHeader
          queryName={queryName}
          status={status}
          onClose={onClose}
          databaseName={activeDatabaseName}
          onRestart={restart}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <CircleAlert className="size-6 text-warning" aria-hidden />
          <h2 className="text-sm font-semibold text-text-primary">
            {STATUS_LABELS[status]}
          </h2>
          {unavailableReasons.length > 0 ? (
            <ul className="max-w-lg space-y-1.5">
              {unavailableReasons.map((reason) => (
                <li
                  key={reason}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-xs leading-relaxed text-text-secondary"
                >
                  {reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="max-w-md text-xs leading-relaxed text-text-muted">
              Run a single SELECT query, then press Visualize to see how SQL
              processes it stage by stage.
            </p>
          )}
          {actualRowCount !== null && (
            <p className="text-[11px] text-text-muted">
              SQLite still executed the query normally — it returned {actualRowCount} row
              {actualRowCount === 1 ? '' : 's'} in the Results tab.
            </p>
          )}
        </div>
      </section>
    )
  }

  return (
    <section className="@container flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <WorkspaceHeader
        queryName={queryName}
        status={status}
        onClose={onClose}
        databaseName={activeDatabaseName}
        validation={validation}
        actualRowCount={actualRowCount}
        truncated={trace.truncated}
        hasAggregation={trace.capability.hasAggregation}
        hasJoin={trace.capability.hasJoin}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        detailsOpen={detailsOpen}
        onToggleDetails={() => setDetailsOpen((open) => !open)}
      />

      {/* Synchronized clause strip — click a clause to jump to its stage. */}
      <ClauseStrip
        query={trace.query}
        activeStage={syncStage}
        seekableStages={seekableStages}
        onSeekStage={(stage) => {
          setInspectedStage(stage)
          seekToStage(stage)
        }}
      />

      {currentQuery !== undefined && currentQuery.trim() !== trace.query.trim() && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            The SQL editor has changed since this visualization. The canvas still
            represents the previously executed query.
          </span>
          {onRevisualize !== undefined && (
            <button
              type="button"
              onClick={onRevisualize}
              className="shrink-0 rounded-md border border-warning/40 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-warning/15"
            >
              Re-visualize
            </button>
          )}
        </div>
      )}

      {/* Validation / truncation warnings */}
      {(validation?.validated === false || trace.truncated) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
          {validation?.validated === false && (
            <span className="inline-flex items-center gap-1.5 rounded border border-danger/40 bg-danger-soft px-2 py-0.5 text-[11px] text-danger">
              <TriangleAlert className="size-3" aria-hidden />
              Not validated against SQLite: {validation.detail}
            </span>
          )}
          {trace.truncated && (
            <span className="inline-flex items-center gap-1.5 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
              <CircleAlert className="size-3" aria-hidden />
              Large table — visualization is capped; the real result is complete.
            </span>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Left: pipeline (only when the container is wide enough) */}
        <div className="hidden w-56 shrink-0 border-r border-border @5xl:block">
          <PipelinePanel
            stages={trace.stages}
            completedByStage={completedByStage}
            activeStage={viewState.activeStage}
            selectedStage={inspectedStage}
            onSelectStage={(stage) => {
              setDetailsOpen(true)
              setInspectedStage(stage)
              seekToStage(stage)
            }}
          />
        </div>

        {/* Center: Flow View (default) or Table View — same playback.
            The floating inspector is layered over this container. */}
        <div
          ref={workspaceLayerRef}
          data-inspector-layer
          className="relative min-w-0 flex-1 overflow-hidden"
        >
          {viewMode === 'flow' && flowGraph !== null && flowState !== null ? (
            <FlowView
              graph={flowGraph}
              flowState={flowState}
              selectedNodeId={selectedNodeId}
              playing={playing}
              focusStage={inspecting ? displayStage : null}
              onSelectNode={handleNodeSelect}
            />
          ) : (
            <TransformationPanel
              snapshot={displaySnapshot}
              activeStage={viewState.activeStage}
              inspecting={inspecting}
            />
          )}

          {viewMode === 'flow' &&
            flowState !== null &&
            selectedNode !== null &&
            inspectorDisplayRect !== null && (
              <FloatingNodeInspector
                node={selectedNode}
                trace={trace}
                status={flowState.nodes[selectedNode.id]}
                revealed={
                  selectedNode.kind !== 'final' ||
                  flowState.nodes[selectedNode.id] === 'completed'
                }
                rect={inspectorDisplayRect}
                bounds={inspectorBounds}
                onRectChange={setInspectorRect}
                onClose={() => setSelectedNodeId(null)}
              />
            )}
        </div>

        {/* Narrow layout: the details panel replaces the canvas (above). */}

        {/* Right: stage explanation. Node data lives in the floating
            inspector over the canvas, not in this panel. On narrow
            containers this becomes a full-size panel so the explanation
            stays readable instead of covering half the canvas. */}
        <div
          className={`${
            detailsOpen ? 'flex' : 'hidden'
          } absolute inset-0 z-40 flex-col bg-surface @4xl:static @4xl:z-auto @4xl:flex @4xl:w-72 @4xl:max-w-none @4xl:border-l @4xl:border-border`}
        >
          <button
            type="button"
            onClick={() => setDetailsOpen(false)}
            aria-label="Close details"
            className="absolute top-1.5 right-1.5 z-50 rounded-md p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary @4xl:hidden"
          >
            <X className="size-3.5" aria-hidden />
          </button>
          <ExplanationPanel stage={displayStage} snapshot={displaySnapshot} />
        </div>
      </div>

      <PlaybackControls
        playing={playing}
        eventIndex={viewState.eventIndex}
        totalEvents={trace.events.length}
        finished={finished}
        speed={speed}
        currentStageLabel={viewState.snapshot?.label ?? null}
        onPlay={() => {
          setInspectedStage(null)
          play()
        }}
        onPause={pause}
        onRestart={() => {
          setInspectedStage(null)
          restart()
        }}
        onPrevious={() => {
          setInspectedStage(null)
          previous()
        }}
        onNext={() => {
          setInspectedStage(null)
          next()
        }}
        onJumpToEnd={() => {
          setInspectedStage(null)
          jumpToEnd()
        }}
        onSeek={(eventIndex) => {
          setInspectedStage(null)
          seek(eventIndex)
        }}
        onSpeedChange={setSpeed}
      />
    </section>
  )
}

interface WorkspaceHeaderProps {
  queryName: string
  status: keyof typeof STATUS_LABELS
  onClose: () => void
  onRestart?: () => void
  databaseName?: string | null
  validation?: ReturnType<typeof useVisualizationStore.getState>['validation']
  actualRowCount?: number | null
  truncated?: boolean
  hasAggregation?: boolean
  hasJoin?: boolean
  viewMode?: 'flow' | 'table'
  onViewModeChange?: (mode: 'flow' | 'table') => void
  detailsOpen?: boolean
  onToggleDetails?: () => void
}

function WorkspaceHeader({
  queryName,
  status,
  onClose,
  databaseName,
  validation,
  actualRowCount,
  hasAggregation,
  hasJoin,
  viewMode,
  onViewModeChange,
  detailsOpen,
  onToggleDetails,
}: WorkspaceHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <Eye className="size-4 text-accent" aria-hidden />
      <h2 className="max-w-72 truncate font-mono text-[13px] font-semibold text-text-primary">
        {queryName}
      </h2>
      {databaseName !== null && databaseName !== undefined && (
        <span className="inline-flex max-w-48 items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">
          <DatabaseIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{databaseName}</span>
        </span>
      )}
      <span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">
        {STATUS_LABELS[status]}
      </span>
      {validation?.validated === true && (
        <span className="inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] text-success">
          <CircleCheck className="size-3" aria-hidden />
          {validation.method === 'ordered' ? 'Validated (ordered)' : 'Validated (unordered)'} vs SQLite
        </span>
      )}
      {hasAggregation === true && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">
          <Info className="size-3" aria-hidden />
          aggregation
        </span>
      )}
      {hasJoin === true && (
        <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-muted">
          <Info className="size-3" aria-hidden />
          join
        </span>
      )}
      {viewMode !== undefined && onViewModeChange !== undefined && (
        <div
          role="tablist"
          aria-label="Visualization mode"
          className="flex rounded-lg border border-border bg-surface-2 p-0.5"
        >
          <button
            role="tab"
            aria-selected={viewMode === 'flow'}
            onClick={() => onViewModeChange('flow')}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              viewMode === 'flow'
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <Waypoints className="size-3" aria-hidden />
            Flow
          </button>
          <button
            role="tab"
            aria-selected={viewMode === 'table'}
            onClick={() => onViewModeChange('table')}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
              viewMode === 'table'
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <Table2 className="size-3" aria-hidden />
            Table
          </button>
        </div>
      )}
      {onToggleDetails !== undefined && (
        <button
          type="button"
          aria-pressed={detailsOpen === true}
          onClick={onToggleDetails}
          className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary @4xl:hidden"
        >
          <Info className="size-3" aria-hidden />
          Details
        </button>
      )}
      <div className="flex-1" />
      {actualRowCount != null && (
        <span className="hidden text-[11px] text-text-muted sm:inline">
          SQLite returned {actualRowCount} row{actualRowCount === 1 ? '' : 's'}
        </span>
      )}
      <motion.button
        type="button"
        onClick={onClose}
        className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
        whileTap={{ scale: 0.97 }}
      >
        Back to query
      </motion.button>
    </header>
  )
}
