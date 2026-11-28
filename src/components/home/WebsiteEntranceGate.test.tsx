// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENTRANCE_DURATION_MS, WebsiteEntranceGate } from './WebsiteEntranceGate'
import { getHomeIntroPhase, resetHomeIntro } from './homeIntro'

const STORAGE_KEY = 'sqlviz.website-entrance.seen.v1'

beforeEach(() => {
  sessionStorage.clear()
  resetHomeIntro()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('WebsiteEntranceGate', () => {
  it('plays the entrance and removes it after exactly three seconds', () => {
    render(
      <WebsiteEntranceGate>
        <div data-testid="home">Home</div>
      </WebsiteEntranceGate>,
    )

    expect(ENTRANCE_DURATION_MS).toBe(3000)
    expect(screen.getByTestId('home')).toBeInTheDocument()
    expect(document.querySelector('.website-entrance')).toBeInTheDocument()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('1')

    act(() => {
      vi.advanceTimersByTime(ENTRANCE_DURATION_MS - 50)
    })
    expect(document.querySelector('.website-entrance')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(document.querySelector('.website-entrance')).not.toBeInTheDocument()
    // The homepage stays mounted throughout (the overlay is purely presentational).
    expect(screen.getByTestId('home')).toBeInTheDocument()
  })

  it('hands the screen to the homepage only when the exit fade starts', () => {
    render(
      <WebsiteEntranceGate>
        <div data-testid="home">Home</div>
      </WebsiteEntranceGate>,
    )

    expect(getHomeIntroPhase()).toBe('pending')
    act(() => {
      vi.advanceTimersByTime(2699)
    })
    expect(getHomeIntroPhase()).toBe('pending')

    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(getHomeIntroPhase()).toBe('released')
  })

  it('releases the homepage immediately when the entrance is skipped', () => {
    sessionStorage.setItem(STORAGE_KEY, '1')
    render(
      <WebsiteEntranceGate>
        <div data-testid="home">Home</div>
      </WebsiteEntranceGate>,
    )
    expect(getHomeIntroPhase()).toBe('released')
  })

  it('does not replay within the same session', () => {
    sessionStorage.setItem(STORAGE_KEY, '1')
    render(
      <WebsiteEntranceGate>
        <div data-testid="home">Home</div>
      </WebsiteEntranceGate>,
    )

    expect(document.querySelector('.website-entrance')).not.toBeInTheDocument()
    expect(screen.getByTestId('home')).toBeInTheDocument()
  })

  it('skips the entrance when reduced motion is requested', () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia

    try {
      render(
        <WebsiteEntranceGate>
          <div data-testid="home">Home</div>
        </WebsiteEntranceGate>,
      )
      expect(document.querySelector('.website-entrance')).not.toBeInTheDocument()
      expect(screen.getByTestId('home')).toBeInTheDocument()
    } finally {
      window.matchMedia = original
    }
  })
})