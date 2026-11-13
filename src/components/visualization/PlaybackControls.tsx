import {
  ChevronLeft,
  ChevronRight,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
} from 'lucide-react'
import { Button } from '../common/Button'
import { PLAYBACK_SPEEDS, type PlaybackSpeed } from '../../store/visualizationStore'

/**
 * Bottom panel: play/pause, stepping, restart, timeline scrubber,
 * current position and speed selection.
 */

interface PlaybackControlsProps {
  playing: boolean
  eventIndex: number
  totalEvents: number
  finished: boolean
  speed: PlaybackSpeed
  currentStageLabel: string | null
  onPlay: () => void
  onPause: () => void
  onRestart: () => void
  onPrevious: () => void
  onNext: () => void
  onJumpToEnd: () => void
  onSeek: (eventIndex: number) => void
  onSpeedChange: (speed: PlaybackSpeed) => void
}

export function PlaybackControls({
  playing,
  eventIndex,
  totalEvents,
  finished,
  speed,
  currentStageLabel,
  onPlay,
  onPause,
  onRestart,
  onPrevious,
  onNext,
  onJumpToEnd,
  onSeek,
  onSpeedChange,
}: PlaybackControlsProps) {
  const lastIndex = Math.max(totalEvents - 1, 0)

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Restart visualization"
          title="Restart"
          onClick={onRestart}
          disabled={totalEvents === 0}
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Previous event"
          title="Previous event"
          onClick={onPrevious}
          disabled={eventIndex === 0}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        {playing ? (
          <Button
            size="sm"
            variant="primary"
            aria-label="Pause"
            title="Pause"
            onClick={onPause}
          >
            <Pause className="size-3.5 fill-current" aria-hidden />
            Pause
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            aria-label={finished ? 'Replay' : 'Play'}
            title={finished ? 'Replay from start' : 'Play'}
            onClick={onPlay}
            disabled={totalEvents === 0}
          >
            <Play className="size-3.5 fill-current" aria-hidden />
            {finished ? 'Replay' : 'Play'}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Next event"
          title="Next event"
          onClick={onNext}
          disabled={eventIndex >= lastIndex}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Jump to final result"
          title="Jump to final result"
          onClick={onJumpToEnd}
          disabled={eventIndex >= lastIndex}
        >
          <SkipForward className="size-3.5" aria-hidden />
        </Button>
      </div>

      {/* Timeline */}
      <div className="flex min-w-40 flex-1 items-center gap-2">
        <input
          type="range"
          min={0}
          max={lastIndex}
          step={1}
          value={eventIndex}
          aria-label="Timeline position"
          onChange={(event) => onSeek(Number(event.target.value))}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-surface-3 accent-[var(--accent)]"
          disabled={totalEvents === 0}
        />
        <span className="w-14 shrink-0 text-right text-[11px] tabular-nums text-text-muted">
          {eventIndex + 1}/{totalEvents}
        </span>
      </div>

      {currentStageLabel !== null && (
        <span className="hidden max-w-56 truncate rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-secondary md:inline">
          {currentStageLabel}
        </span>
      )}

      {/* Speed selector */}
      <div
        role="group"
        aria-label="Playback speed"
        className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-2 p-0.5"
      >
        <Gauge className="ml-1 size-3 text-text-muted" aria-hidden />
        {PLAYBACK_SPEEDS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={speed === candidate}
            onClick={() => onSpeedChange(candidate)}
            className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums transition-colors ${
              speed === candidate
                ? 'bg-surface-3 text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {candidate}×
          </button>
        ))}
      </div>
    </div>
  )
}
