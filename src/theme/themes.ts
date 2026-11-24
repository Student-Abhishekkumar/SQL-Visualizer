/**
 * Theme registry shared by the settings UI, the theme provider and the
 * Monaco editor. The CSS custom properties for each theme live in
 * `index.css` (`[data-theme='…']`); this module owns identity, grouping,
 * light/dark mode, preview swatches and persistence keys.
 */

export type ThemeId =
  | 'light'
  | 'dark'
  | 'midnight'
  | 'dracula'
  | 'nord'
  | 'solarized-dark'
  | 'glassy'
  | 'bloody'
  | 'cyberpunk'

export type ThemeMode = 'light' | 'dark'
export type ThemeGroup = 'classic' | 'visual'

export interface ThemeDefinition {
  id: ThemeId
  name: string
  group: ThemeGroup
  mode: ThemeMode
  description: string
  /** Swatches used by the theme selector preview. */
  preview: {
    bg: string
    surface: string
    accent: string
    text: string
  }
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: 'light',
    name: 'Light',
    group: 'classic',
    mode: 'light',
    description: 'Clean daylight palette with deep blue accents.',
    preview: { bg: '#f6f8fc', surface: '#ffffff', accent: '#1d4ed8', text: '#101828' },
  },
  {
    id: 'dark',
    name: 'Dark',
    group: 'classic',
    mode: 'dark',
    description: 'The default deep navy workspace.',
    preview: { bg: '#080d17', surface: '#111a2a', accent: '#72a0ff', text: '#f1f5fc' },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    group: 'classic',
    mode: 'dark',
    description: 'Deep blue night shift with bright sky accents.',
    preview: { bg: '#070d1a', surface: '#101b30', accent: '#5eb0ff', text: '#e8eefb' },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    group: 'classic',
    mode: 'dark',
    description: 'Purple, pink and mint on warm charcoal.',
    preview: { bg: '#282a36', surface: '#44475a', accent: '#d8b4fe', text: '#f8f8f2' },
  },
  {
    id: 'nord',
    name: 'Nord',
    group: 'classic',
    mode: 'dark',
    description: 'Cool arctic blues and snow-light text.',
    preview: { bg: '#2e3440', surface: '#434c5e', accent: '#a3d3e0', text: '#eceff4' },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    group: 'classic',
    mode: 'dark',
    description: 'Engineered teal with warm solar accents.',
    preview: { bg: '#002b36', surface: '#073642', accent: '#7cc4f0', text: '#eee8d5' },
  },
  {
    id: 'glassy',
    name: 'Glassy',
    group: 'visual',
    mode: 'dark',
    description: 'Translucent, frosted layers with luminous edges.',
    preview: { bg: '#0b1220', surface: '#1b2a44', accent: '#67e8f9', text: '#f4f8ff' },
  },
  {
    id: 'bloody',
    name: 'Bloody',
    group: 'visual',
    mode: 'dark',
    description: 'Near-black charcoal with restrained crimson accents.',
    preview: { bg: '#0a0505', surface: '#2a1212', accent: '#ef4444', text: '#f7e9e9' },
  },
  {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    group: 'visual',
    mode: 'dark',
    description: 'Neon cyan and magenta over a subtle grid.',
    preview: { bg: '#05010f', surface: '#1b0f36', accent: '#22d3ee', text: '#f3ecff' },
  },
]

export const THEME_IDS: readonly ThemeId[] = THEMES.map((theme) => theme.id)
export const CLASSIC_THEMES: readonly ThemeDefinition[] = THEMES.filter(
  (theme) => theme.group === 'classic',
)
export const VISUAL_THEMES: readonly ThemeDefinition[] = THEMES.filter(
  (theme) => theme.group === 'visual',
)

export const DEFAULT_THEME: ThemeId = 'dark'
export const THEME_STORAGE_KEY = 'sql-visualizer-theme'
export const REDUCED_EFFECTS_STORAGE_KEY = 'sql-visualizer-reduced-effects'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

export function themeById(id: ThemeId): ThemeDefinition {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[1]!
}

/** Light/dark mode of a theme, used for the `dark` class and color-scheme. */
export function themeMode(id: ThemeId): ThemeMode {
  return themeById(id).mode
}