import { create } from 'zustand'
import type {
  StageSnapshot,
  VisualizationEvent,
  VisualizationTrace,
  VisualizationViewState,
  ValidationResult,
} from '../types/visualization'
import { getActiveDatabaseId, getLiveDatabase } from '../services/database/databaseManager'
import { simulateAndValidate } from '../services/visualization/validation'

/**
 * Playback controller (Stage 2, Milestone 5).
 *
 * Owns the playback position over a generated visualization trace and
 * folds events into a `VisualizationViewState` for the UI. The trace is
 * produced independently (services/visualization) and is immutable —
 * seeking never regenerates data, it only changes which events are
 * visible, so playback is fully deterministic in both directions.
 *
 * The controller must never touch the SQL execution path: loading a new
 * trace cancels any running timer, and stopping playback leaves
 * execution state untouched.
 */

/** Base dwell time per event at 1x, in milliseconds. */
const BASE_EVENT_MS = 700

/** Allowed playback speeds. */
export const PLAYBACK_SPEEDS = [0.5, 1, 1.5, 2] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

interface VisualizationState {
  /** The immutable trace being played. Null when nothing is loaded. */
  trace: VisualizationTrace | null
  /** Current playback position (index into trace.events). */
  eventIndex: number
  playing: boolean
  speed: PlaybackSpeed
  /** Folded view state for the current position. */
  viewState: VisualizationViewState
  /** True when playback reached (or passed) the last event. */
  finished: boolean
  /** Monotonic token that invalidates stale timer callbacks. */
  sessionId: number

  /** Lifecycle of the last visualize request. */
  status: 'idle' | 'ready' | 'unsupported' | 'unavailable'
  /** Why visualization is not available (unsupported query, no DB…). */
  unavailableReasons: string[]
  /** Parity validation of the loaded trace against SQLite. */
  validation: ValidationResult | null
  /** Row count SQLite actually returned (null when not executed). */
  actualRowCount: number | null
  /** Database the loaded trace belongs to (null when nothing is loaded). */
  databaseId: string | null

  /**
   * Full pipeline: interpret → simulate → execute for real → validate →
   * load for playback. Never touches the SQL execution state.
   */
  visualize: (sql: string, statements: string[]) => void

  /** Load a fresh trace and reset playback to the beginning. */
  loadTrace: (trace: VisualizationTrace) => void
  /** Clear the current trace (e.g. when leaving visualization mode). */
  clear: () => void
  /**
   * Fully invalidate visualization state when the active database
   * changes: a trace from another database must never be shown, and
   * stale status/validation text must not linger.
   */
  resetForDatabaseSwitch: () => void

  play: () => void
  pause: () => void
  restart: () => void
  next: () => void
  previous: () => void
  /** Deterministic seek: backward and forward both just set the index. */
  seek: (eventIndex: number) => void
  /** Jump to the STAGE_COMPLETED event of a given stage. */
  seekToStage: (stage: string) => void
  /** Jump to the final event. */
  jumpToEnd: () => void
  setSpeed: (speed: PlaybackSpeed) => void

  /** Internal: advance one event while playing. */
  tick: () => void
}

/** Fold events[0..eventIndex] into the view state. */
export function foldEvents(
  events: VisualizationEvent[],
  eventIndex: number,
): VisualizationViewState {
  const clamped = Math.max(0, Math.min(eventIndex, events.length - 1))
  const event = events[clamped] ?? null

  let snapshot: StageSnapshot | null = null
  const completedStages: StageSnapshot[] = []
  const seenStages = new Set<string>()
  for (let i = 0; i <= clamped; i++) {
    const candidate = events[i]
    if (candidate?.type === 'STAGE_COMPLETED' && candidate.snapshot !== undefined) {
      snapshot = candidate.snapshot
      // Keep one snapshot per logical stage (first completed wins for
      // repeated stages, e.g. multiple JOINs).
      if (!seenStages.has(candidate.snapshot.stage)) {
        seenStages.add(candidate.snapshot.stage)
        completedStages.push(candidate.snapshot)
      }
    }
  }

  const activeStage =
    event !== null && event.type !== 'STAGE_COMPLETED' && event.type !== 'QUERY_VISUALIZATION_COMPLETED'
      ? event.stage
      : null

  const finished = clamped >= events.length - 1

  return {
    eventIndex: clamped,
    event,
    snapshot,
    activeStage,
    completedStages,
    finished,
  }
}

/** Dwell time for the current speed. */
export function eventDurationMs(speed: PlaybackSpeed): number {
  return BASE_EVENT_MS / speed
}

function emptyViewState(): VisualizationViewState {
  return {
    eventIndex: 0,
    event: null,
    snapshot: null,
    activeStage: null,
    completedStages: [],
    finished: false,
  }
}

let timerId: ReturnType<typeof setTimeout> | null = null

function clearTimer(): void {
  if (timerId !== null) {
    clearTimeout(timerId)
    timerId = null
  }
}

function scheduleNextTick(
  get: () => VisualizationState,
  set: (partial: Partial<VisualizationState>) => void,
  sessionId: number,
): void {
  clearTimer()
  const state = get()
  if (!state.playing || state.trace === null) return
  const last = state.trace.events.length - 1
  if (state.eventIndex >= last) {
    set({ playing: false, finished: true })
    return
  }
  timerId = setTimeout(() => {
    if (get().sessionId !== sessionId) return // stale session — ignore
    get().tick()
  }, eventDurationMs(get().speed))
}

export const useVisualizationStore = create<VisualizationState>()((set, get) => ({
  trace: null,
  eventIndex: 0,
  playing: false,
  speed: 1,
  viewState: emptyViewState(),
  finished: false,
  sessionId: 0,

  status: 'idle',
  unavailableReasons: [],
  validation: null,
  actualRowCount: null,
  databaseId: null,

  visualize: (sql, statements) => {
    const db = getLiveDatabase()
    const databaseId = getActiveDatabaseId()
    if (db === null) {
      clearTimer()
      const sessionId = get().sessionId + 1
      set({
        trace: null,
        playing: false,
        status: 'unavailable',
        unavailableReasons: ['The database is not ready yet. Run a query first, then visualize.'],
        validation: null,
        actualRowCount: null,
        databaseId,
        viewState: emptyViewState(),
        finished: false,
        eventIndex: 0,
        sessionId,
      })
      return
    }
    const outcome = simulateAndValidate(sql, statements, db)
    if (!outcome.simulation.ok) {
      clearTimer()
      const sessionId = get().sessionId + 1
      set({
        trace: null,
        playing: false,
        status: 'unsupported',
        unavailableReasons: outcome.simulation.reasons,
        validation: null,
        actualRowCount: outcome.execution?.values.length ?? null,
        databaseId,
        viewState: emptyViewState(),
        finished: false,
        eventIndex: 0,
        sessionId,
      })
      return
    }
    clearTimer()
    const sessionId = get().sessionId + 1
    set({
      trace: outcome.simulation.trace,
      eventIndex: 0,
      playing: false,
      viewState: foldEvents(outcome.simulation.trace.events, 0),
      finished: false,
      sessionId,
      status: 'ready',
      unavailableReasons: [],
      validation: outcome.validation,
      actualRowCount: outcome.execution?.values.length ?? null,
      databaseId,
    })
  },

  loadTrace: (trace) => {
    clearTimer()
    const sessionId = get().sessionId + 1
    set({
      trace,
      eventIndex: 0,
      playing: false,
      viewState: foldEvents(trace.events, 0),
      finished: false,
      sessionId,
      databaseId: getActiveDatabaseId(),
    })
  },

  clear: () => {
    clearTimer()
    const sessionId = get().sessionId + 1
    set({
      trace: null,
      eventIndex: 0,
      playing: false,
      viewState: emptyViewState(),
      finished: false,
      sessionId,
      databaseId: null,
    })
  },

  resetForDatabaseSwitch: () => {
    clearTimer()
    const sessionId = get().sessionId + 1
    set({
      trace: null,
      eventIndex: 0,
      playing: false,
      viewState: emptyViewState(),
      finished: false,
      sessionId,
      status: 'idle',
      unavailableReasons: [],
      validation: null,
      actualRowCount: null,
      databaseId: null,
    })
  },

  play: () => {
    const state = get()
    if (state.trace === null) return
    const last = state.trace.events.length - 1
    if (state.eventIndex >= last) {
      // Replay from the beginning when playing after finishing.
      set({ eventIndex: 0, playing: true, finished: false, viewState: foldEvents(state.trace.events, 0) })
    } else {
      set({ playing: true })
    }
    scheduleNextTick(get, set, get().sessionId)
  },

  pause: () => {
    clearTimer()
    set({ playing: false })
  },

  restart: () => {
    const state = get()
    if (state.trace === null) return
    clearTimer()
    const sessionId = get().sessionId + 1
    set({
      eventIndex: 0,
      playing: false,
      finished: false,
      viewState: foldEvents(state.trace.events, 0),
      sessionId,
    })
  },

  next: () => {
    const state = get()
    if (state.trace === null) return
    const last = state.trace.events.length - 1
    const nextIndex = Math.min(state.eventIndex + 1, last)
    clearTimer()
    set({
      eventIndex: nextIndex,
      playing: false,
      finished: nextIndex >= last,
      viewState: foldEvents(state.trace.events, nextIndex),
    })
  },

  previous: () => {
    const state = get()
    if (state.trace === null) return
    const previousIndex = Math.max(state.eventIndex - 1, 0)
    clearTimer()
    set({
      eventIndex: previousIndex,
      playing: false,
      viewState: foldEvents(state.trace.events, previousIndex),
    })
  },

  seek: (eventIndex) => {
    const state = get()
    if (state.trace === null) return
    const last = state.trace.events.length - 1
    const clamped = Math.max(0, Math.min(Math.trunc(eventIndex), last))
    clearTimer()
    set({
      eventIndex: clamped,
      playing: false,
      finished: clamped >= last,
      viewState: foldEvents(state.trace.events, clamped),
    })
  },

  seekToStage: (stage) => {
    const state = get()
    if (state.trace === null) return
    const index = state.trace.events.findIndex(
      (event) => event.type === 'STAGE_COMPLETED' && event.stage === stage,
    )
    if (index < 0) return
    get().seek(index)
  },

  jumpToEnd: () => {
    const state = get()
    if (state.trace === null) return
    const last = state.trace.events.length - 1
    clearTimer()
    set({
      eventIndex: last,
      playing: false,
      finished: true,
      viewState: foldEvents(state.trace.events, last),
    })
  },

  setSpeed: (speed) => {
    set({ speed })
    if (get().playing) {
      scheduleNextTick(get, set, get().sessionId)
    }
  },

  tick: () => {
    const state = get()
    if (!state.playing || state.trace === null) return
    const last = state.trace.events.length - 1
    if (state.eventIndex >= last) {
      clearTimer()
      set({ playing: false, finished: true })
      return
    }
    const nextIndex = state.eventIndex + 1
    set({
      eventIndex: nextIndex,
      finished: nextIndex >= last,
      viewState: foldEvents(state.trace.events, nextIndex),
    })
    scheduleNextTick(get, set, state.sessionId)
  },
}))
