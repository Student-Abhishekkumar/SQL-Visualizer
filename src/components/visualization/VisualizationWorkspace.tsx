import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Database as DatabaseIcon,
  Eye,
  Info,
  PanelRightClose,
  PanelRightOpen,
  Table2,
  TriangleAlert,
  Waypoints,
} from 'lucide-react'
import { motion } from 'motion/react'
import { PipelinePanel } from './PipelinePanel'
import { TransformationPanel } from './TransformationPanel'
import { PlaybackControls } from './PlaybackControls'
import { ClauseStrip } from './ClauseStrip'
import { FlowView } from './flow/FlowView'
import {
  FloatingNodeInspector,
  INSPECTOR_HEADER_HEIGHT,
  type InspectorWindowMode,
} from './flow/FloatingNodeInspector'
import { FloatingInspectorDock } from './flow/FloatingInspectorDock'
import {
  DocumentationEdgeTab,
  DocumentationSidebar,
} from './DocumentationSidebar'
import { Tooltip } from '../common/Tooltip'
import { buildFlowGraph, deriveFlowState } from '../../services/visualization/graphBuilder'
import { mapQueryClauses, spanOfStage } from '../../services/visualization/clauseMapper'
import {
  blockEvents,
  blockStages,
  blocksOf,
  eventStageKey,
  rootBlockIdOf,
  snapshotStageKey,
  splitStageKey,
  stageKeyFor,
} from '../../services/visualization/queryBlocks'
import {
  clampPosition,
  clampRect,
  defaultRect,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
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

/** Workspace width below which the inspector docks instead of floating. */
const NARROW_WORKSPACE_MAX = 480
/** Gap kept between the docked inspector and the workspace edge. */
const EDGE_MARGIN = 16

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
  const activeBlockId = useVisualizationStore((state) => state.activeBlockId)
  const setActiveBlock = useVisualizationStore((state) => state.setActiveBlock)
  const setSpeed = useVisualizationStore((state) => state.setSpeed)

  // Stage (within a query block) selected for inspection. Stored as a
  // block-scoped key so the same stage in two blocks stays distinct.
  const [inspectedKey, setInspectedKey] = useState<string | null>(null)
  // View mode: the animated flow canvas is the default; both views share playback.
  const [viewMode, setViewMode] = useState<'flow' | 'table'>('flow')
  // Documentation sidebar state. Local to the workspace so it survives
  // playback, node switches and Query/Canvas switching for this session;
  // it never touches the SQL/execution stores. Compact windows start
  // closed so the sidebar opens as an overlay rather than covering the
  // canvas on first use; the user's choice is remembered afterwards.
  const [docsOpen, setDocsOpen] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= 1024,
  )
  // Selected flow node id — resolved against the current graph, so a
  // stale id (new trace) simply resolves to nothing selected.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  // Inspector window mode. A single source of truth prevents the old
  // ambiguous "minimize" flag from meaning both header-collapse and hide.
  // The mode is stored with the trace it belongs to, so a new visualization
  // (a new inspection session) starts expanded without a reset effect and a
  // collapsed/minimized window is never carried into a different query.
  const [inspectorSession, setInspectorSession] = useState<{
    trace: typeof trace
    mode: InspectorWindowMode
  }>(() => ({ trace, mode: 'expanded' }))
  const inspectorMode: InspectorWindowMode =
    inspectorSession.trace === trace ? inspectorSession.mode : 'expanded'
  const setInspectorMode = useCallback(
    (mode: InspectorWindowMode): void => setInspectorSession({ trace, mode }),
    [trace],
  )
  // Floating inspector geometry. Owned here (not by the popup) so position
  // and size survive switching nodes, closing/reopening and playback
  // updates for the lifetime of the workspace.
  const workspaceLayerRef = useRef<HTMLDivElement>(null)
  const [inspectorBounds, setInspectorBounds] = useState<WindowBounds>({ width: 0, height: 0 })
  const [inspectorRect, setInspectorRect] = useState<WindowRect | null>(null)

  const rootId = trace !== null ? rootBlockIdOf(trace) : null
  const queryBlocks = useMemo(() => (trace !== null ? blocksOf(trace) : []), [trace])

  // Snapshots keyed by block-scoped stage key. Nested blocks are
  // precomputed before the outer pipeline, so every nested block except
  // the one currently playing counts as completed.
  const completedByKey = useMemo(() => {
    const map = new Map<string, StageSnapshot>()
    if (trace === null) return map
    const root = rootBlockIdOf(trace)
    for (const snapshot of viewState.completedStages) {
      const key = snapshotStageKey(snapshot, root)
      if (!map.has(key)) map.set(key, snapshot)
    }
    for (const block of trace.nestedQueries ?? []) {
      if (block.id === activeBlockId || block.status === 'unsupported') continue
      for (const snapshot of block.stageSnapshots) {
        const key = stageKeyFor(block.id, snapshot.stage, root)
        if (!map.has(key)) map.set(key, snapshot)
      }
    }
    return map
  }, [trace, viewState.completedStages, activeBlockId])

  // The explanation/panel follows the inspected stage when set, else the
  // last completed snapshot of live playback.
  const liveSnapshot = viewState.snapshot
  const inspecting = inspectedKey !== null && completedByKey.has(inspectedKey)
  const displaySnapshot = inspecting
    ? (completedByKey.get(inspectedKey) ?? null)
    : liveSnapshot
  const inspectedStage =
    inspectedKey !== null && rootId !== null ? splitStageKey(inspectedKey, rootId).stage : null
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
      new Set(completedByKey.keys()),
      viewState.activeStageKey,
      viewState.finished,
    )
  }, [flowGraph, completedByKey, viewState.activeStageKey, viewState.finished])

  // Pipeline panel data for the block currently being played. Stage names
  // alone would collide across blocks, so everything here is scoped to
  // the active block.
  const pipelineStages = useMemo(
    () => (trace !== null ? blockStages(trace, activeBlockId) : []),
    [trace, activeBlockId],
  )
  const pipelineCompleted = useMemo(() => {
    const map = new Map<VisualizedStage, StageSnapshot>()
    for (const stage of pipelineStages) {
      const key = stageKeyFor(activeBlockId, stage, rootId ?? undefined)
      const snapshot = completedByKey.get(key)
      if (snapshot !== undefined) map.set(stage, snapshot)
    }
    return map
  }, [pipelineStages, completedByKey, activeBlockId, rootId])
  const activeStageOfBlock: VisualizedStage | null =
    viewState.activeStageKey !== null && rootId !== null
      ? (() => {
          const { blockId, stage } = splitStageKey(viewState.activeStageKey, rootId)
          return blockId === activeBlockId ? stage : null
        })()
      : null
  const selectedStageInBlock = inspecting ? inspectedStage : null
  const totalEvents = useMemo(
    () => (trace !== null ? blockEvents(trace, activeBlockId).length : 0),
    [trace, activeBlockId],
  )

  // The visible rectangle is always clamped into the measured workspace so
  // a viewport resize can never strand the popup off-screen. Collapsed mode
  // clamps the real header box, not the saved expanded height — otherwise
  // the header could not reach the lower part of the workspace even though
  // nothing exists below it.
  const inspectorDisplayRect =
    inspectorRect === null
      ? null
      : inspectorMode === 'collapsed'
        ? (() => {
            const visible = clampPosition(
              { ...inspectorRect, height: INSPECTOR_HEADER_HEIGHT },
              inspectorBounds,
            )
            return { ...inspectorRect, x: visible.x, y: visible.y }
          })()
        : clampRect(inspectorRect, inspectorBounds)

  // Track the canvas layer size so the popup can be clamped into view.
  // Measure once when the ready workspace mounts (a newly attached ref is
  // not guaranteed to have received its first ResizeObserver callback
  // yet), then keep it current from the observer/resize events.
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
    measure()
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
  // pushing the playback-synced highlight into the Monaco editor. Spans
  // carry their query block, so an inner WHERE never highlights the
  // outer WHERE (and vice versa).
  const clauseSpans = useMemo(
    () =>
      trace !== null
        ? mapQueryClauses(trace.query, {
            nestedQueries: trace.nestedQueries,
            rootBlockId: rootId ?? undefined,
          })
        : [],
    [trace, rootId],
  )
  // Every stage of every block is a valid seek target; each key is
  // block-scoped, so two WHERE clauses stay distinct.
  const seekableStages = useMemo(() => {
    if (trace === null) return new Set<string>()
    const keys = new Set<string>()
    for (const stage of trace.stages) keys.add(stageKeyFor(rootId, stage, rootId ?? undefined))
    for (const operation of trace.compound?.operations ?? []) {
      keys.add(
        stageKeyFor(rootId, 'COMPOUND', rootId ?? undefined, operation.snapshot.compoundOperationId),
      )
    }
    for (const block of trace.nestedQueries ?? []) {
      for (const snapshot of block.stageSnapshots) {
        keys.add(stageKeyFor(block.id, snapshot.stage, rootId ?? undefined))
      }
    }
    return keys
  }, [trace, rootId])

  // Synchronize the active stage with the external editor store: the
  // Monaco editor decorates the clause of the currently active stage
  // (or nothing when playback is idle/finished or the query changed).
  // A completed event leaves activeStage null; the clause the user is
  // looking at is then the stage that just completed.
  const setStageHighlight = useEditorStore((state) => state.setStageHighlight)
  const syncStageKey: string | null =
    viewState.activeStageKey ??
    (viewState.event?.type === 'STAGE_COMPLETED'
      ? eventStageKey(viewState.event, rootId ?? undefined)
      : null)
  useEffect(() => {
    if (trace === null || syncStageKey === null) {
      setStageHighlight(null)
      return
    }
    const { blockId, stage } =
      rootId !== null ? splitStageKey(syncStageKey, rootId) : { blockId: null, stage: syncStageKey }
    const span = spanOfStage(clauseSpans, stage as VisualizedStage, blockId)
    setStageHighlight(
      span !== null ? { start: span.start, end: span.end, stage: stage as VisualizedStage } : null,
    )
  }, [syncStageKey, clauseSpans, trace, rootId, setStageHighlight])

  /**
   * First-open placement: prefer the space beside the clicked node, and
   * fall back to the workspace default when the node box is unavailable
   * (e.g. before layout has run).
   */
  const initialRectFor = useCallback((nodeId: string): WindowRect => {
    const layer = workspaceLayerRef.current
    const layerBox = layer?.getBoundingClientRect()
    if (layer === null || layerBox === undefined) {
      const empty = { width: 0, height: 0 }
      return rectNearAnchor(null, defaultRect(empty), empty)
    }
    // clientWidth is 0 in jsdom and can lag a resize; prefer the measured
    // rect and fall back to the viewport so the narrow check is reliable.
    const measured = layerBox.width > 0 ? layerBox.width : layer.clientWidth
    const narrow = (measured > 0 ? measured : window.innerWidth) < NARROW_WORKSPACE_MAX
    const bounds: WindowBounds = { width: layerBox.width, height: layerBox.height }
    // Narrow (phone) workspaces cannot fit a 380 px floating window beside a
    // node without covering the graph. Dock the inspector to the bottom edge
    // and open it collapsed, so the canvas stays visible and another node can
    // be tapped to change the selection.
    if (narrow) {
      const width = Math.max(MIN_WINDOW_WIDTH, layerBox.width - EDGE_MARGIN * 2)
      return {
        x: Math.max(0, (layerBox.width - width) / 2),
        y: Math.max(0, layerBox.height - INSPECTOR_HEADER_HEIGHT),
        width,
        height: Math.min(
          Math.max(MIN_WINDOW_HEIGHT, Math.round(layerBox.height * 0.6)),
          Math.max(MIN_WINDOW_HEIGHT, layerBox.height - EDGE_MARGIN),
        ),
      }
    }
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
  }, [])

  // Clicking a graph node selects it for inspection and traces its real
  // upstream data path. Selection is inspection-only: it never seeks the
  // timeline, re-runs SQL or changes playback. Seeking stays on the
  // clause strip, pipeline and timeline controls.
  const handleNodeSelect = useCallback(
    (node: { stage: VisualizedStage | null; id: string; blockId?: string }): void => {
      const deselecting = selectedNodeId === node.id
      setSelectedNodeId(deselecting ? null : node.id)
      if (deselecting) {
        // Clicking the selected node again only clears the inspection; the
        // current playback position is left untouched. A later selection
        // opens a full window again rather than a stale collapsed/docked one.
        setInspectorMode('expanded')
        setInspectedKey(null)
        return
      }
      if (inspectorRect === null) {
        setInspectorRect(initialRectFor(node.id))
      }
      // On a phone the inspector docks to the bottom as a header; expanding
      // it would cover the graph, so it starts collapsed and the Details
      // toggle opens the full panel when the user asks for it.
      const layer = workspaceLayerRef.current
      const layerWidth = layer?.getBoundingClientRect().width ?? 0
      const effectiveWidth =
        (layerWidth > 0 ? layerWidth : (layer?.clientWidth ?? 0)) || window.innerWidth
      if (effectiveWidth < NARROW_WORKSPACE_MAX) setInspectorMode('collapsed')
      // Do not force the details panel open: on narrow layouts it replaces
      // the canvas, which would hide the very upstream trace the click just
      // started. The Details toggle still opens the inspector for this node.
      // A node inspection must not leave an unrelated pinned stage behind.
      setInspectedKey(null)
      if (node.stage === null) {
        setStageHighlight(null)
        return
      }
      const span = spanOfStage(clauseSpans, node.stage, node.blockId)
      setStageHighlight(
        span !== null ? { start: span.start, end: span.end, stage: node.stage } : null,
      )
    },
    [clauseSpans, initialRectFor, inspectorRect, selectedNodeId, setInspectorMode, setStageHighlight],
  )

  const closeInspector = useCallback(() => {
    setSelectedNodeId(null)
    setInspectorMode('expanded')
  }, [setInspectorMode])

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
              Run a supported SELECT query — including CTEs, IN / EXISTS
              subqueries, and UNION / UNION ALL — then press Visualize to see
              how SQL processes it stage by stage.
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
    <section className="@container flex h-full min-h-0 flex-col overflow-clip bg-surface">
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
        docsOpen={docsOpen}
        onToggleDocs={() => setDocsOpen((open) => !open)}
      />

      {/* Synchronized clause strip — click a clause to jump to its stage. */}
      <ClauseStrip
        query={trace.query}
        activeStageKey={syncStageKey}
        seekableStages={seekableStages}
        nestedQueries={trace.nestedQueries}
        rootBlockId={rootId ?? undefined}
        onSeekStage={(stage) => {
          setInspectedKey(stageKeyFor(activeBlockId, stage, rootId ?? undefined))
          seekToStage(stage)
        }}
        onSeekStageKey={(key, stage, blockId) => {
          setActiveBlock(blockId === rootId ? null : blockId)
          setInspectedKey(key)
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
      {(validation?.validated === false ||
        trace.truncated ||
        (validation?.nested?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
          {validation?.validated === false && (
            <span className="inline-flex items-center gap-1.5 rounded border border-danger/40 bg-danger-soft px-2 py-0.5 text-[11px] text-danger">
              <TriangleAlert className="size-3" aria-hidden />
              Not validated against SQLite: {validation.detail}
            </span>
          )}
          {validation?.nested?.map((nested) => (
            <span
              key={nested.blockId}
              title={nested.detail ?? undefined}
              className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] ${
                nested.skipped === true
                  ? 'border-border bg-surface text-text-muted'
                  : nested.validated
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-danger/40 bg-danger-soft text-danger'
              }`}
            >
              {nested.skipped === true ? (
                <CircleAlert className="size-3" aria-hidden />
              ) : nested.validated ? (
                <CircleCheck className="size-3" aria-hidden />
              ) : (
                <TriangleAlert className="size-3" aria-hidden />
              )}
              {nested.label}:{' '}
              {nested.skipped === true
                ? 'not compared with SQLite'
                : nested.validated
                  ? 'matches SQLite'
                  : 'differs from SQLite'}
            </span>
          ))}
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
            stages={pipelineStages}
            completedByStage={pipelineCompleted}
            activeStage={activeStageOfBlock}
            selectedStage={selectedStageInBlock}
            blocks={queryBlocks}
            activeBlockId={activeBlockId}
            onSelectBlock={(blockId) => {
              setActiveBlock(blockId === rootId ? null : blockId)
              setInspectedKey(null)
            }}
            onSelectStage={(stage) => {
              setDocsOpen(true)
              setInspectedKey(stageKeyFor(activeBlockId, stage, rootId ?? undefined))
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
              focusStageKey={inspecting ? inspectedKey : null}
              onSelectNode={handleNodeSelect}
              onDeselectNode={closeInspector}
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
                mode={inspectorMode}
                onModeChange={setInspectorMode}
                onRectChange={setInspectorRect}
                onClose={closeInspector}
              />
            )}

          {viewMode === 'flow' && selectedNode !== null && inspectorMode === 'minimized' && (
            <FloatingInspectorDock
              node={selectedNode}
              onRestore={() => setInspectorMode('expanded')}
              onClose={closeInspector}
            />
          )}
        </div>

        {/* Right: independently togglable documentation sidebar. Node data
            lives in the floating inspector over the canvas; this sidebar
            holds the stage guide and references only. */}
        <DocumentationSidebar
          open={docsOpen}
          stage={displayStage}
          snapshot={displaySnapshot}
          onClose={() => setDocsOpen(false)}
        />
        {!docsOpen && <DocumentationEdgeTab onOpen={() => setDocsOpen(true)} />}
      </div>

      <PlaybackControls
        playing={playing}
        eventIndex={viewState.eventIndex}
        totalEvents={totalEvents}
        finished={finished}
        speed={speed}
        currentStageLabel={viewState.snapshot?.label ?? null}
        onPlay={() => {
          setInspectedKey(null)
          play()
        }}
        onPause={pause}
        onRestart={() => {
          setInspectedKey(null)
          restart()
        }}
        onPrevious={() => {
          setInspectedKey(null)
          previous()
        }}
        onNext={() => {
          setInspectedKey(null)
          next()
        }}
        onJumpToEnd={() => {
          setInspectedKey(null)
          jumpToEnd()
        }}
        onSeek={(eventIndex) => {
          setInspectedKey(null)
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
  docsOpen?: boolean
  onToggleDocs?: () => void
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
  docsOpen,
  onToggleDocs,
}: WorkspaceHeaderProps) {
  return (
    <header className="glass-surface flex flex-wrap items-center gap-2 border-b border-border bg-surface px-2 py-1.5 sm:px-3 sm:py-2">
      <Eye className="size-4 shrink-0 text-accent" aria-hidden />
      <h2 className="max-w-72 min-w-0 truncate font-mono text-[13px] font-semibold text-text-primary">
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
          className="flex shrink-0 rounded-lg border border-border bg-surface-2 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'flow'}
            onClick={() => onViewModeChange('flow')}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors lg:min-h-0 ${
              viewMode === 'flow'
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <Waypoints className="size-3" aria-hidden />
            Flow
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'table'}
            onClick={() => onViewModeChange('table')}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors lg:min-h-0 ${
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
      {onToggleDocs !== undefined && (
        <Tooltip label={docsOpen === true ? 'Hide documentation sidebar' : 'Show documentation sidebar'}>
          <button
            type="button"
            id="documentation-toggle"
            aria-label="Toggle documentation sidebar"
            aria-pressed={docsOpen === true}
            aria-controls="documentation-sidebar"
            onClick={onToggleDocs}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:min-h-0 ${
              docsOpen === true
                ? 'border-accent/40 bg-accent-soft text-text-primary'
                : 'border-border bg-surface-2 text-text-secondary hover:border-border-strong hover:text-text-primary'
            }`}
          >
            {docsOpen === true ? (
              <PanelRightClose className="size-3" aria-hidden />
            ) : (
              <PanelRightOpen className="size-3" aria-hidden />
            )}
            <span className="hidden @3xl:inline">Documentation</span>
          </button>
        </Tooltip>
      )}
      <div className="ml-auto flex items-center gap-2">
        {actualRowCount != null && (
          <span className="hidden text-[11px] text-text-muted sm:inline">
            SQLite returned {actualRowCount} row{actualRowCount === 1 ? '' : 's'}
          </span>
        )}
        <motion.button
          type="button"
          onClick={onClose}
          className="min-h-11 shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:min-h-0"
          whileTap={{ scale: 0.97 }}
        >
          Back to query
        </motion.button>
      </div>
    </header>
  )
}
