import { useMemo } from 'react'
import { mapQueryClauses } from '../../services/visualization/clauseMapper'
import type {
  NestedQueryTrace,
  QueryBlockId,
  VisualizedStage,
} from '../../types/visualization'

/**
 * Synchronized query clause strip: one chip per SQL clause found in the
 * visualized query, positioned where the clause actually appears in the
 * text (via the clause mapper). Clicking a chip jumps playback to that
 * clause's stage; the chip for the active stage is highlighted. Chips
 * for stages the simulator did not run are subdued and not clickable.
 *
 * Nested query blocks have their own clauses, so chips are identified by
 * their block-scoped stage key rather than the bare stage name.
 */

interface ClauseStripProps {
  query: string
  activeStage?: VisualizedStage | null
  /** Block-scoped form of `activeStage` (`q2:WHERE`). Wins when set. */
  activeStageKey?: string | null
  /** Block-scoped keys that exist in the current trace (clickable). */
  seekableStages: ReadonlySet<string>
  /** Nested blocks of the statement, used to attribute occurrences. */
  nestedQueries?: NestedQueryTrace[]
  rootBlockId?: QueryBlockId
  onSeekStage: (stage: VisualizedStage, blockId?: QueryBlockId) => void
  /** Preferred block-aware seek handler (receives `q2:WHERE`). */
  onSeekStageKey?: (stageKey: string, stage: VisualizedStage, blockId: QueryBlockId) => void
}

export function ClauseStrip({
  query,
  activeStage = null,
  activeStageKey = null,
  seekableStages,
  nestedQueries,
  rootBlockId,
  onSeekStage,
  onSeekStageKey,
}: ClauseStripProps) {
  const spans = useMemo(
    () => mapQueryClauses(query, { nestedQueries, rootBlockId }),
    [query, nestedQueries, rootBlockId],
  )

  if (spans.length === 0) return null

  const activeKey = activeStageKey ?? activeStage

  return (
    <div
      role="toolbar"
      aria-label="Query clauses"
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5"
    >
      <span className="text-[9px] font-semibold tracking-wide text-text-muted uppercase">
        Query
      </span>
      {spans.map((span) => {
        const seekable = seekableStages.has(span.stageKey)
        const isActive = activeKey === span.stageKey
        return (
          <button
            key={`${span.stageKey}-${span.start}`}
            type="button"
            disabled={!seekable}
            onClick={() => {
              if (onSeekStageKey !== undefined) {
                onSeekStageKey(span.stageKey, span.stage, span.blockId)
              } else {
                onSeekStage(span.stage, span.blockId)
              }
            }}
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
