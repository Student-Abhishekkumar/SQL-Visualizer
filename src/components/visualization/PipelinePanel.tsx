import {
  Check,
  CircleDashed,
  CircleX,
  Layers,
  Loader2,
  Table2,
} from 'lucide-react'
import { STAGE_TITLES } from '../../services/visualization/explanations'
import type { StageSnapshot, VisualizedStage } from '../../types/visualization'

/**
 * Left panel: the logical execution pipeline. Each stage shows its
 * current status (pending / active / completed); completed stages are
 * clickable to inspect their snapshot.
 */

interface PipelinePanelProps {
  stages: VisualizedStage[]
  /** Snapshot per completed stage, keyed by stage name. */
  completedByStage: Map<VisualizedStage, StageSnapshot>
  activeStage: VisualizedStage | null
  /** Selected stage for inspection. */
  selectedStage: VisualizedStage | null
  onSelectStage: (stage: VisualizedStage) => void
}

function StageIcon({
  status,
}: {
  status: 'pending' | 'active' | 'completed'
}) {
  if (status === 'completed') {
    return <Check className="size-3.5 text-success" aria-hidden />
  }
  if (status === 'active') {
    return <Loader2 className="size-3.5 animate-spin text-accent" aria-hidden />
  }
  return <CircleDashed className="size-3.5 text-text-muted" aria-hidden />
}

export function PipelinePanel({
  stages,
  completedByStage,
  activeStage,
  selectedStage,
  onSelectStage,
}: PipelinePanelProps) {
  return (
    <nav aria-label="Execution pipeline" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center gap-1.5 px-3 pt-3 pb-1.5 text-[11px] font-semibold tracking-wide text-text-muted uppercase">
        <Layers className="size-3.5" aria-hidden />
        Pipeline
      </div>
      <ol className="relative flex-1 space-y-0.5 px-2 pb-3">
        {stages.map((stage, index) => {
          const completed = completedByStage.has(stage)
          const active = activeStage === stage
          const status = completed ? 'completed' : active ? 'active' : 'pending'
          const snapshot = completedByStage.get(stage)
          const clickable = completed
          const selected = selectedStage === stage
          return (
            <li key={stage}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => onSelectStage(stage)}
                aria-current={active ? 'step' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  selected
                    ? 'bg-accent-soft'
                    : clickable
                      ? 'hover:bg-surface-2'
                      : 'cursor-default'
                }`}
              >
                <StageIcon status={status} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`truncate text-[13px] font-medium ${
                      completed
                        ? 'text-text-primary'
                        : active
                          ? 'text-accent'
                          : 'text-text-muted'
                    }`}
                  >
                    {stage}
                  </div>
                  <div className="truncate text-[11px] text-text-muted">
                    {snapshot !== undefined
                      ? `${snapshot.outputRowCount} row${snapshot.outputRowCount === 1 ? '' : 's'} out`
                      : STAGE_TITLES[stage].split('—')[1]?.trim() ?? ''}
                  </div>
                </div>
                {snapshot?.truncated === true && (
                  <span className="rounded border border-warning/40 px-1 text-[9px] text-warning">
                    capped
                  </span>
                )}
              </button>
              {index < stages.length - 1 && (
                <div
                  aria-hidden
                  className={`mx-auto h-2 w-px ${completed ? 'bg-success/40' : 'bg-border'}`}
                />
              )}
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[10px] text-text-muted">
        <Table2 className="size-3" aria-hidden />
        Logical SQL order — click a completed stage to inspect it
      </div>
    </nav>
  )
}

/** Badge for unsupported stages shown in the pipeline header. */
export function UnsupportedStageBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-danger/40 bg-danger-soft px-1.5 py-0.5 text-[10px] text-danger">
      <CircleX className="size-3" aria-hidden />
      unsupported
    </span>
  )
}
