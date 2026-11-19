import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  StageSnapshot,
  VisualizationEvent,
  VisualizationTrace,
} from '../types/visualization'
import {
  eventDurationMs,
  foldEvents,
  PLAYBACK_SPEEDS,
  useVisualizationStore,
} from './visualizationStore'

/**
 * Playback controller tests. Traces are synthetic but the event/snapshot
 * shapes follow the real simulator contracts.
 */

function stageSnapshot(stage: StageSnapshot['stage'], rowCount: number): StageSnapshot {
  return {
    stage,
    label: stage,
    columns: ['value'],
    rows: Array.from({ length: rowCount }, (_, index) => ({ id: `r${index + 1}`, values: [index + 1] })),
    removedRows: [],
    roles: {},
    groups: [],
    explanation: `after ${stage}`,
    inputRowCount: rowCount + 1,
    outputRowCount: rowCount,
    truncated: false,
  }
}

function event(
  type: VisualizationEvent['type'],
  stage: VisualizationEvent['stage'],
  index: number,
  snapshot?: StageSnapshot,
): VisualizationEvent {
  return {
    id: `evt${index + 1}`,
    type,
    description: `${type} on ${stage ?? 'query'}`,
    stage,
    snapshot,
  }
}

/** FROM completed → two WHERE events → WHERE completed → LIMIT completed. */
function makeTrace(): VisualizationTrace {
  const events: VisualizationEvent[] = [
    event('QUERY_STARTED', null, 0),
    event('SOURCE_TABLE_LOADED', 'FROM', 1),
    event('ROW_EVALUATED', 'WHERE', 2),
    event('ROW_FILTERED', 'WHERE', 3),
    event('STAGE_COMPLETED', 'WHERE', 4, stageSnapshot('WHERE', 3)),
    event('STAGE_COMPLETED', 'LIMIT', 5, stageSnapshot('LIMIT', 2)),
    event('QUERY_VISUALIZATION_COMPLETED', null, 6),
  ]
  return {
    query: 'SELECT value FROM demo',
    statementType: 'SELECT',
    capability: {
      supported: true,
      supportedStages: ['FROM', 'WHERE', 'SELECT', 'LIMIT'],
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: false,
      hasJoin: false,
      estimatedComplexity: 'small',
    },
    stages: ['FROM', 'WHERE', 'SELECT', 'LIMIT'],
    events,
    stageSnapshots: [stageSnapshot('WHERE', 3), stageSnapshot('LIMIT', 2)],
    sourceTables: [
      {
        name: 'demo',
        alias: null,
        columns: ['value'],
        rowCount: 4,
        previewRows: [{ id: 'demo#1', values: [1] }],
        role: 'from',
        joinType: null,
        on: null,
      },
    ],
    totalSteps: events.length,
    finalRows: [],
    finalColumns: [],
    hasDeterministicOrder: false,
    truncated: false,
  }
}

function resetStore(): void {
  useVisualizationStore.getState().clear()
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('foldEvents', () => {
  const trace = makeTrace()

  it('starts with no snapshot and no active stage', () => {
    const view = foldEvents(trace.events, 0)
    expect(view.snapshot).toBeNull()
    expect(view.event?.type).toBe('QUERY_STARTED')
    expect(view.activeStage).toBeNull()
    expect(view.completedStages).toEqual([])
    expect(view.finished).toBe(false)
  })

  it('reports the active stage while a stage is running', () => {
    const view = foldEvents(trace.events, 2)
    expect(view.activeStage).toBe('WHERE')
    expect(view.snapshot).toBeNull() // WHERE not completed yet
  })

  it('carries the last completed snapshot after completion', () => {
    const view = foldEvents(trace.events, 4)
    expect(view.snapshot?.stage).toBe('WHERE')
    expect(view.snapshot?.outputRowCount).toBe(3)
    expect(view.completedStages.map((snapshot) => snapshot.stage)).toEqual(['WHERE'])
    expect(view.activeStage).toBeNull()
  })

  it('accumulates completed stages in stage order', () => {
    const view = foldEvents(trace.events, 5)
    expect(view.completedStages.map((snapshot) => snapshot.stage)).toEqual(['WHERE', 'LIMIT'])
    expect(view.snapshot?.stage).toBe('LIMIT')
  })

  it('marks the last event as finished', () => {
    const view = foldEvents(trace.events, 6)
    expect(view.finished).toBe(true)
    expect(view.event?.type).toBe('QUERY_VISUALIZATION_COMPLETED')
  })

  it('clamps out-of-range indices deterministically', () => {
    expect(foldEvents(trace.events, 99).eventIndex).toBe(6)
    expect(foldEvents(trace.events, -5).eventIndex).toBe(0)
  })
})

describe('playback state', () => {
  it('loads a trace and resets to the first event', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    const state = useVisualizationStore.getState()
    expect(state.trace?.events).toHaveLength(7)
    expect(state.eventIndex).toBe(0)
    expect(state.playing).toBe(false)
    expect(state.finished).toBe(false)
    expect(state.viewState.event?.type).toBe('QUERY_STARTED')
  })

  it('plays forward on a timer and stops at the end', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().play()
    expect(useVisualizationStore.getState().playing).toBe(true)

    vi.advanceTimersByTime(eventDurationMs(1) * 3)
    expect(useVisualizationStore.getState().eventIndex).toBe(3)

    vi.advanceTimersByTime(eventDurationMs(1) * 10)
    const state = useVisualizationStore.getState()
    expect(state.eventIndex).toBe(6)
    expect(state.playing).toBe(false)
    expect(state.finished).toBe(true)
  })

  it('pauses and resumes without losing position', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().play()
    vi.advanceTimersByTime(eventDurationMs(1) * 2)
    useVisualizationStore.getState().pause()
    expect(useVisualizationStore.getState().playing).toBe(false)
    const at = useVisualizationStore.getState().eventIndex

    vi.advanceTimersByTime(eventDurationMs(1) * 5)
    expect(useVisualizationStore.getState().eventIndex).toBe(at) // frozen while paused

    useVisualizationStore.getState().play()
    expect(useVisualizationStore.getState().playing).toBe(true)
    vi.advanceTimersByTime(eventDurationMs(1))
    expect(useVisualizationStore.getState().eventIndex).toBe(at + 1)
  })

  it('respects playback speed (0.5x is twice as slow, 2x twice as fast)', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().setSpeed(2)
    useVisualizationStore.getState().play()
    vi.advanceTimersByTime(eventDurationMs(2) * 2)
    expect(useVisualizationStore.getState().eventIndex).toBe(2)

    resetStore()
    useVisualizationStore.getState().loadTrace(makeTrace())
    useVisualizationStore.getState().setSpeed(0.5)
    useVisualizationStore.getState().play()
    vi.advanceTimersByTime(eventDurationMs(0.5) * 1 - 1)
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    vi.advanceTimersByTime(1)
    expect(useVisualizationStore.getState().eventIndex).toBe(1)
  })

  it('steps next/previous and pauses on manual stepping', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().play()
    useVisualizationStore.getState().next()
    const afterNext = useVisualizationStore.getState()
    expect(afterNext.eventIndex).toBe(1)
    expect(afterNext.playing).toBe(false)

    useVisualizationStore.getState().previous()
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    expect(useVisualizationStore.getState().finished).toBe(false)

    useVisualizationStore.getState().jumpToEnd()
    expect(useVisualizationStore.getState().finished).toBe(true)
    useVisualizationStore.getState().previous()
    expect(useVisualizationStore.getState().eventIndex).toBe(5)
    expect(useVisualizationStore.getState().finished).toBe(false)
    expect(useVisualizationStore.getState().viewState.finished).toBe(false)
    useVisualizationStore.getState().next()
    expect(useVisualizationStore.getState().eventIndex).toBe(6)
    expect(useVisualizationStore.getState().finished).toBe(true)
    expect(useVisualizationStore.getState().viewState.finished).toBe(true)
  })

  it('seeks forward and backward to identical view states', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    store.setSpeed(1) // a previous test may have changed the persisted speed
    useVisualizationStore.getState().seek(4)
    const direct = useVisualizationStore.getState().viewState

    resetStore()
    useVisualizationStore.getState().loadTrace(makeTrace())
    useVisualizationStore.getState().play()
    vi.advanceTimersByTime(eventDurationMs(1) * 4)
    const played = useVisualizationStore.getState().viewState
    expect(played).toEqual(direct)

    useVisualizationStore.getState().seek(1)
    expect(useVisualizationStore.getState().viewState.snapshot).toBeNull()
    expect(useVisualizationStore.getState().playing).toBe(false)
    expect(useVisualizationStore.getState().finished).toBe(false)
    useVisualizationStore.getState().seek(6)
    expect(useVisualizationStore.getState().finished).toBe(true)
    useVisualizationStore.getState().seek(3)
    expect(useVisualizationStore.getState().finished).toBe(false)
  })

  it('seeks to a stage completion by stage name', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().seekToStage('LIMIT')
    const state = useVisualizationStore.getState()
    expect(state.eventIndex).toBe(5)
    expect(state.viewState.snapshot?.stage).toBe('LIMIT')
    // Unknown stages do not move the position.
    useVisualizationStore.getState().seekToStage('JOIN')
    expect(useVisualizationStore.getState().eventIndex).toBe(5)
  })

  it('restart resets to the first event; play-after-finish replays', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().jumpToEnd()
    expect(useVisualizationStore.getState().finished).toBe(true)
    useVisualizationStore.getState().restart()
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    expect(useVisualizationStore.getState().finished).toBe(false)

    useVisualizationStore.getState().jumpToEnd()
    useVisualizationStore.getState().play()
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    expect(useVisualizationStore.getState().playing).toBe(true)
  })

  it('keeps an empty timeline unfinished and never schedules a playback loop', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace({ ...makeTrace(), events: [], totalSteps: 0, stageSnapshots: [] })

    for (const move of ['next', 'previous', 'jumpToEnd'] as const) {
      useVisualizationStore.getState()[move]()
      expect(useVisualizationStore.getState().eventIndex).toBe(0)
      expect(useVisualizationStore.getState().finished).toBe(false)
      expect(useVisualizationStore.getState().viewState.finished).toBe(false)
    }
    useVisualizationStore.getState().seek(99)
    useVisualizationStore.getState().play()
    expect(useVisualizationStore.getState().playing).toBe(false)
    expect(useVisualizationStore.getState().finished).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a single-event timeline complete at its only valid cursor', () => {
    const trace = makeTrace()
    const store = useVisualizationStore.getState()
    store.loadTrace({ ...trace, events: [trace.events[0]!], totalSteps: 1 })
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    expect(useVisualizationStore.getState().finished).toBe(true)
    expect(useVisualizationStore.getState().viewState.finished).toBe(true)

    useVisualizationStore.getState().previous()
    expect(useVisualizationStore.getState().finished).toBe(true)
    useVisualizationStore.getState().next()
    expect(useVisualizationStore.getState().finished).toBe(true)
    useVisualizationStore.getState().seek(0)
    expect(useVisualizationStore.getState().finished).toBe(true)
    useVisualizationStore.getState().restart()
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    expect(useVisualizationStore.getState().finished).toBe(true)
  })

  it('reuses one timer when play is requested repeatedly', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().play()
    useVisualizationStore.getState().play()
    expect(vi.getTimerCount()).toBe(1)
    useVisualizationStore.getState().pause()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loading a new trace invalidates the old playback (no stale data)', () => {
    const store = useVisualizationStore.getState()
    store.loadTrace(makeTrace())
    useVisualizationStore.getState().play()
    const oldSession = useVisualizationStore.getState().sessionId
    store.loadTrace(makeTrace())
    expect(useVisualizationStore.getState().sessionId).toBe(oldSession + 1)
    expect(useVisualizationStore.getState().playing).toBe(false)
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
    // Old timer must not advance the new trace.
    vi.advanceTimersByTime(eventDurationMs(1) * 3)
    expect(useVisualizationStore.getState().eventIndex).toBe(0)
  })

  it('does nothing without a trace', () => {
    const store = useVisualizationStore.getState()
    store.play()
    store.next()
    store.previous()
    store.seek(3)
    store.jumpToEnd()
    expect(useVisualizationStore.getState().trace).toBeNull()
  })
})

describe('speed contract', () => {
  it('exposes the four spec speeds', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 1.5, 2])
  })

  it('scales dwell time inversely with speed', () => {
    expect(eventDurationMs(1)).toBe(700)
    expect(eventDurationMs(2)).toBe(350)
    expect(eventDurationMs(1.5)).toBeCloseTo(466.67, 2)
    expect(eventDurationMs(0.5)).toBe(1400)
  })
})
