import { useMemo, useState } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Eye,
  Info,
  TriangleAlert,
} from 'lucide-react'
import { motion } from 'motion/react'
import { PipelinePanel } from './PipelinePanel'
import { TransformationPanel } from './TransformationPanel'
import { ExplanationPanel } from './ExplanationPanel'
import { PlaybackControls } from './PlaybackControls'
import { useVisualizationStore } from '../../store/visualizationStore'
import type { StageSnapshot, VisualizedStage } from '../../types/visualization'

/**
 * The full visualization workspace: pipeline (left), data
 * transformation (center), explanation (right) and playback controls
 * (bottom). Fully responsive — side panels collapse on narrow screens.
 */

interface VisualizationWorkspaceProps {
  queryName: string
  onClose: () => void
}

const STATUS_LABELS = {
  idle: 'No visualization yet',
  ready: 'Simulation ready',
  unsupported: 'Cannot visualize this query',
  unavailable: 'Database not ready',
} as const

export function VisualizationWorkspace({ queryName, onClose }: VisualizationWorkspaceProps) {
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

  if (status !== 'ready' || trace === null) {
    return (
      <section className="flex h-full flex-col overflow-hidden bg-surface">
        <WorkspaceHeader
          queryName={queryName}
          status={status}
          onClose={onClose}
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
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <WorkspaceHeader
        queryName={queryName}
        status={status}
        onClose={onClose}
        onRestart={restart}
        validation={validation}
        actualRowCount={actualRowCount}
        truncated={trace.truncated}
        hasAggregation={trace.capability.hasAggregation}
        hasJoin={trace.capability.hasJoin}
      />

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

      <div className="flex min-h-0 flex-1">
        {/* Left: pipeline */}
        <div className="hidden w-56 shrink-0 border-r border-border md:block">
          <PipelinePanel
            stages={trace.stages}
            completedByStage={completedByStage}
            activeStage={viewState.activeStage}
            selectedStage={inspectedStage}
            onSelectStage={(stage) => {
              setInspectedStage((current) => (current === stage ? null : stage))
              seekToStage(stage)
            }}
          />
        </div>

        {/* Center: transformation */}
        <div className="min-w-0 flex-1 overflow-hidden">
          <TransformationPanel
            snapshot={displaySnapshot}
            activeStage={viewState.activeStage}
            inspecting={inspecting}
          />
        </div>

        {/* Right: explanation */}
        <div className="hidden w-72 shrink-0 border-l border-border md:block">
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
        onJumpToEnd={jumpToEnd}
        onSeek={seek}
        onSpeedChange={setSpeed}
      />
    </section>
  )
}

interface WorkspaceHeaderProps {
  queryName: string
  status: keyof typeof STATUS_LABELS
  onClose: () => void
  onRestart: () => void
  validation?: ReturnType<typeof useVisualizationStore.getState>['validation']
  actualRowCount?: number | null
  truncated?: boolean
  hasAggregation?: boolean
  hasJoin?: boolean
}

function WorkspaceHeader({
  queryName,
  status,
  onClose,
  validation,
  actualRowCount,
  hasAggregation,
  hasJoin,
}: WorkspaceHeaderProps) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <Eye className="size-4 text-accent" aria-hidden />
      <h2 className="max-w-72 truncate font-mono text-[13px] font-semibold text-text-primary">
        {queryName}
      </h2>
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
        Back to results
      </motion.button>
    </header>
  )
}
