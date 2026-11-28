import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finishHomeIntro,
  getHomeIntroPhase,
  releaseHomeIntro,
  resetHomeIntro,
  subscribeHomeIntro,
} from './homeIntro'

beforeEach(() => {
  resetHomeIntro()
})

describe('home intro handoff', () => {
  it('starts pending so nothing animates under the entrance', () => {
    expect(getHomeIntroPhase()).toBe('pending')
  })

  it('releases exactly once', () => {
    const listener = vi.fn()
    subscribeHomeIntro(listener)
    releaseHomeIntro()
    releaseHomeIntro()
    expect(getHomeIntroPhase()).toBe('released')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('records that the choreography was consumed', () => {
    releaseHomeIntro()
    finishHomeIntro()
    expect(getHomeIntroPhase()).toBe('played')
    // A later release must not resurrect it (back/forward navigation).
    releaseHomeIntro()
    expect(getHomeIntroPhase()).toBe('played')
  })

  it('cannot finish before it was released', () => {
    finishHomeIntro()
    expect(getHomeIntroPhase()).toBe('pending')
  })

  it('notifies subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeHomeIntro(listener)
    releaseHomeIntro()
    unsubscribe()
    finishHomeIntro()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
