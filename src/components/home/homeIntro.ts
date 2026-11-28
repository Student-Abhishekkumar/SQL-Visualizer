import { useSyncExternalStore } from 'react'

/**
 * Handoff signal between the website entrance and the homepage.
 *
 * The homepage is mounted underneath the entrance overlay from the first
 * frame, so nothing may start on mount: the landing choreography is armed
 * exactly when the entrance hands the screen over. This module keeps that
 * single fact outside React so the gate and the page cannot disagree.
 *
 *   pending  → the cinematic entrance still owns the viewport
 *   released → the handoff happened, the homepage may animate
 *   played   → the choreography was consumed this session (no replays)
 */
export type HomeIntroPhase = 'pending' | 'released' | 'played'

let phase: HomeIntroPhase = 'pending'
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getHomeIntroPhase(): HomeIntroPhase {
  return phase
}

export function subscribeHomeIntro(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Called by the entrance gate the moment it starts handing over. */
export function releaseHomeIntro(): void {
  if (phase !== 'pending') return
  phase = 'released'
  emit()
}

/** Called once the homepage choreography is committed to play. */
export function finishHomeIntro(): void {
  if (phase !== 'released') return
  phase = 'played'
  emit()
}

/** Test/HMR escape hatch: forget the handoff. */
export function resetHomeIntro(): void {
  if (phase === 'pending') return
  phase = 'pending'
  emit()
}

export function useHomeIntroPhase(): HomeIntroPhase {
  return useSyncExternalStore(subscribeHomeIntro, getHomeIntroPhase, () => 'played' as const)
}
