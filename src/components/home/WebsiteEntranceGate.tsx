import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { releaseHomeIntro } from './homeIntro'
import { WebsiteEntrance } from './WebsiteEntrance'

/** Once per browser session (per tab): replays on a fresh visit, not on
 *  refresh, internal navigation or rerenders. */
const STORAGE_KEY = 'sqlviz.website-entrance.seen.v1'
export const ENTRANCE_DURATION_MS = 3000

function hasSeenEntrance(): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function rememberEntrance(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // Session storage can be unavailable (private mode / blocked); the
    // entrance still plays once for this mount.
  }
}

/**
 * Website-level entrance gate.
 *
 * The homepage is always rendered underneath so the transition at three
 * seconds reveals an already-mounted, immediately usable page with no blank
 * frame — but it is rendered at rest. The gate is the only thing allowed to
 * start the homepage landing animation: it releases the handoff signal when
 * the exit fade begins (or immediately when the entrance is skipped), so the
 * page can never burn its choreography unseen behind the overlay.
 *
 * The entrance is purely presentational: it never touches SQLite,
 * application readiness or the workspace loader.
 *
 * It does not render on the workspace route (the gate only wraps the home
 * route), so direct `#/app` URLs skip it entirely.
 */
export function WebsiteEntranceGate({ children }: { children: ReactNode }) {
  const reducedMotion = usePrefersReducedMotion()
  const [playing, setPlaying] = useState(() => {
    if (typeof window === 'undefined') return false
    if (reducedMotion) return false
    return !hasSeenEntrance()
  })
  const [fading, setFading] = useState(false)

  // Skip case (return visit, reduced motion, direct render): hand control to
  // the homepage before the first paint so it never shows a pre-roll frame.
  useLayoutEffect(() => {
    if (!playing) releaseHomeIntro()
  }, [playing])

  useEffect(() => {
    if (!playing) return
    rememberEntrance()

    let fadeTimer: number | undefined
    let exitTimer: number | undefined
    let fadeRemaining = 2700
    let exitRemaining = ENTRANCE_DURATION_MS
    let startedAt = performance.now()
    let hidden = document.hidden

    const clearTimers = () => {
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer)
      if (exitTimer !== undefined) window.clearTimeout(exitTimer)
      fadeTimer = undefined
      exitTimer = undefined
    }

    const schedule = () => {
      clearTimers()
      if (hidden) return
      startedAt = performance.now()
      // The fade is the handoff: from this frame the entrance is leaving and
      // the homepage owns the screen, so its landing choreography may start.
      fadeTimer = window.setTimeout(() => {
        setFading(true)
        releaseHomeIntro()
      }, fadeRemaining)
      exitTimer = window.setTimeout(() => setPlaying(false), exitRemaining)
    }

    // A hidden tab must not burn through the three-second story unseen: both
    // the CSS timeline (paused by WebsiteEntrance) and these timers freeze,
    // then resume with the same remaining time.
    const onVisibilityChange = () => {
      if (document.hidden === hidden) return
      if (document.hidden) {
        const elapsed = performance.now() - startedAt
        fadeRemaining = Math.max(0, fadeRemaining - elapsed)
        exitRemaining = Math.max(0, exitRemaining - elapsed)
        hidden = true
        clearTimers()
        return
      }
      hidden = false
      schedule()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearTimers()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [playing])

  return (
    <>
      {children}
      {playing ? <WebsiteEntrance exiting={fading} /> : null}
    </>
  )
}