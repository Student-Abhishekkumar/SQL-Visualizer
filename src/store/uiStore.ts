import { create } from 'zustand'

export type Theme = 'dark' | 'light'

const THEME_STORAGE_KEY = 'sql-visualizer-theme'

function readStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'dark'
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * Application UI state: theme and modal visibility flags.
 * Theme is dark-first and persisted to localStorage.
 */
interface UIState {
  theme: Theme
  toggleTheme: () => void
  isSettingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  isSidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
}

export const useUIStore = create<UIState>()((set, get) => ({
  theme: readStoredTheme(),
  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    set({ theme: next })
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
  },
  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  isSidebarOpen: false,
  toggleSidebar: () => set({ isSidebarOpen: !get().isSidebarOpen }),
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
}))
