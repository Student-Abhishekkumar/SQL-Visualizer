import { useMemo } from 'react'
import { mapQueryClauses } from '../../services/visualization/clauseMapper'
import type { VisualizedStage } from '../../types/visualization'

/**
 * Synchronized query clause strip: one chip per SQL clause found in the
 * visualized query, positioned where the clause actually appears in the
 * text (via the clause mapper). Clicking a chip jumps playback to that
 * clause's stage; the chip for the active stage is highlighted. Chips
 * for stages the simulator did not run are subdued and not clickable.
 */

interface ClauseStripProps {
  query: string
  activeStage: VisualizedStage | null
  /** Stages that exist in the current trace (clickable targets). */
  seekableStages: ReadonlySet<VisualizedStage>
  onSeekStage: (stage: VisualizedStage) => void
}

export function ClauseStrip({ query, activeStage, seekableStages, onSeekStage }: ClauseStripProps) {
  const spans = useMemo(() => mapQueryClauses(query), [query])

  if (spans.length === 0) return null

  return (
    <div
      role="toolbar"
      aria-label="Query clauses"
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5"
    >
      <span className="text-[9px] font-semibold tracking-wide text-text-muted uppercase">
        Query
      </span>
      {spans.map((span, index) => {
        const seekable = seekableStages.has(span.stage)
        const isActive = activeStage === span.stage
        return (
          <button
            key={`${span.stage}-${index}`}
            type="button"
            disabled={!seekable}
            onClick={() => onSeekStage(span.stage)}
            title={`${span.keyword} clause${seekable ? ' — jump to this stage' : ''}`}
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              isActive
                ? 'border-accent bg-accent-soft font-semibold text-accent'
                : seekable
                  ? 'border-border bg-surface-2 text-text-secondary hover:border-accent/60 hover:text-text-primary'
                  : 'border-border/60 bg-surface text-text-muted opacity-60'
            }`}
          >
            {span.keyword}
          </button>
        )
      })}
      <span className="ml-1 text-[9px] text-text-muted">click a clause to jump to it</span>
    </div>
  )
}
