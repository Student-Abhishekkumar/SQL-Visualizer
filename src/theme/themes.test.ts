import { describe, expect, it } from 'vitest'
import {
  CLASSIC_THEMES,
  DEFAULT_THEME,
  THEMES,
  THEME_IDS,
  VISUAL_THEMES,
  isThemeId,
  themeById,
  themeMode,
} from './themes'

describe('theme registry', () => {
  it('defines exactly nine themes with unique ids', () => {
    expect(THEMES).toHaveLength(9)
    expect(new Set(THEME_IDS).size).toBe(9)
  })

  it('groups six classic themes and three visual styles', () => {
    expect(CLASSIC_THEMES.map((theme) => theme.id)).toEqual([
      'light',
      'dark',
      'midnight',
      'dracula',
      'nord',
      'solarized-dark',
    ])
    expect(VISUAL_THEMES.map((theme) => theme.id)).toEqual([
      'glassy',
      'bloody',
      'cyberpunk',
    ])
  })

  it('gives every theme a name, description and four preview swatches', () => {
    for (const theme of THEMES) {
      expect(theme.name.length).toBeGreaterThan(0)
      expect(theme.description.length).toBeGreaterThan(0)
      for (const swatch of Object.values(theme.preview)) {
        expect(swatch).toMatch(/^(#[0-9a-fA-F]{3,8}|rgba?\()/)
      }
    }
  })

  it('accepts every theme id and rejects unknown values', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true)
    expect(isThemeId('neon')).toBe(false)
    expect(isThemeId(null)).toBe(false)
    expect(isThemeId(42)).toBe(false)
  })

  it('derives light/dark mode and resolves themes with a dark fallback', () => {
    expect(themeMode('light')).toBe('light')
    expect(themeMode('dark')).toBe('dark')
    expect(themeMode('glassy')).toBe('dark')
    expect(themeMode('cyberpunk')).toBe('dark')
    expect(themeById('nord').name).toBe('Nord')
    expect(themeById('light').mode).toBe('light')
    expect(DEFAULT_THEME).toBe('dark')
  })
})