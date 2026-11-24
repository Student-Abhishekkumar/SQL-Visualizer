import { create } from 'zustand'
import {
  DEFAULT_THEME,
  REDUCED_EFFECTS_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isThemeId,
  themeMode,
  type ThemeId,
} from '../theme/themes'

export type Theme = ThemeId
export type WorkspaceView = 'query' | 'canvas'

function readStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return DEFAULT_THEME
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return isThemeId(stored) ? stored : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function readStoredReducedEffects(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    return localStorage.getItem(REDUCED_EFFECTS_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the value still applies for this session */
  }
}

/**
 * Application UI state: theme, reduced effects, workspace view and
 * modal/drawer visibility. The theme and reduced-effects choice are
 * persisted to localStorage. Workspace view is session-only and always
 * starts on Query; an old persisted Canvas choice is ignored.
 */
interface UIState {
  theme: Theme
  setTheme: (theme: Theme) => void
  /** Quick light/dark switch used by the navbar; keeps the current mode family. */
  toggleTheme: () => void

  /** Minimise blur/glow/grid effects (Glassy, Cyberpunk). */
  reducedEffects: boolean
  toggleReducedEffects: () => void

  /**
   * Which workspace is visible. Both views stay mounted in the DOM so
   * editor, results, canvas zoom/pan, selection and playback survive
   * switching between them.
   */
  workspaceView: WorkspaceView
  setWorkspaceView: (view: WorkspaceView) => void
  toggleWorkspaceView: () => void

  isSettingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  isDatabaseManagerOpen: boolean
  setDatabaseManagerOpen: (open: boolean) => void
  /** Which panel the manager opens on. */
  databaseManagerMode: 'manage' | 'create'
  setDatabaseManagerMode: (mode: 'manage' | 'create') => void
  /** Open the manager directly on a panel. */
  openDatabaseManager: (mode?: 'manage' | 'create') => void
  isSidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    if (get().theme === theme) return
    set({ theme })
    persist(THEME_STORAGE_KEY, theme)
  },
  toggleTheme: () => {
    const next: Theme = themeMode(get().theme) === 'dark' ? 'light' : 'dark'
    set({ theme: next })
    persist(THEME_STORAGE_KEY, next)
  },

  reducedEffects: readStoredReducedEffects(),
  toggleReducedEffects: () => {
    const next = !get().reducedEffects
    set({ reducedEffects: next })
    persist(REDUCED_EFFECTS_STORAGE_KEY, String(next))
  },

  workspaceView: 'query',
  setWorkspaceView: (view) => {
    if (get().workspaceView === view) return
    set({ workspaceView: view })
  },
  toggleWorkspaceView: () => {
    const next = get().workspaceView === 'query' ? 'canvas' : 'query'
    set({ workspaceView: next })
  },

  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  isDatabaseManagerOpen: false,
  setDatabaseManagerOpen: (open) => set({ isDatabaseManagerOpen: open }),
  databaseManagerMode: 'manage',
  setDatabaseManagerMode: (mode) => set({ databaseManagerMode: mode }),
  openDatabaseManager: (mode = 'manage') =>
    set({ isDatabaseManagerOpen: true, databaseManagerMode: mode }),
  isSidebarOpen: false,
  toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
}))