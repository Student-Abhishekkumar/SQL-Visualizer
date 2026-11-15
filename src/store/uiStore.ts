import { create } from 'zustand'

export type Theme = 'dark' | 'light'
export type WorkspaceView = 'query' | 'canvas'

const THEME_STORAGE_KEY = 'sql-visualizer-theme'
const VIEW_STORAGE_KEY = 'sql-visualizer-view'

function readStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'dark'
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function readStoredView(): WorkspaceView {
  if (typeof localStorage === 'undefined') return 'query'
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'canvas' ? 'canvas' : 'query'
  } catch {
    return 'query'
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
 * Application UI state: theme, workspace view, modal/drawer visibility.
 * Theme and the Query/Canvas choice are persisted to localStorage.
 */
interface UIState {
  theme: Theme
  toggleTheme: () => void

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
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    set({ theme: next })
    persist(THEME_STORAGE_KEY, next)
  },

  workspaceView: readStoredView(),
  setWorkspaceView: (view) => {
    if (get().workspaceView === view) return
    set({ workspaceView: view })
    persist(VIEW_STORAGE_KEY, view)
  },
  toggleWorkspaceView: () => {
    const next = get().workspaceView === 'query' ? 'canvas' : 'query'
    set({ workspaceView: next })
    persist(VIEW_STORAGE_KEY, next)
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
