// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from './uiStore'
import { REDUCED_EFFECTS_STORAGE_KEY, THEME_STORAGE_KEY } from '../theme/themes'

beforeEach(() => {
  localStorage.clear()
  useUIStore.setState({ theme: 'dark', reducedEffects: false })
})

describe('uiStore theme persistence', () => {
  it('persists the selected theme across reloads', async () => {
    useUIStore.getState().setTheme('nord')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('nord')

    vi.resetModules()
    const { useUIStore: reloaded } = await import('./uiStore')
    expect(reloaded.getState().theme).toBe('nord')
  })

  it('restores a persisted theme on load', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dracula')
    vi.resetModules()
    const { useUIStore: reloaded } = await import('./uiStore')
    expect(reloaded.getState().theme).toBe('dracula')
  })

  it('falls back to the default dark theme for unknown stored values', async () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    vi.resetModules()
    const { useUIStore: reloaded } = await import('./uiStore')
    expect(reloaded.getState().theme).toBe('dark')
  })

  it('toggles between light and dark modes from any theme', () => {
    useUIStore.getState().setTheme('nord')
    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('light')

    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('dark')
  })

  it('persists the reduced-effects preference', async () => {
    useUIStore.getState().toggleReducedEffects()
    expect(localStorage.getItem(REDUCED_EFFECTS_STORAGE_KEY)).toBe('true')

    vi.resetModules()
    const { useUIStore: reloaded } = await import('./uiStore')
    expect(reloaded.getState().reducedEffects).toBe(true)
  })
})