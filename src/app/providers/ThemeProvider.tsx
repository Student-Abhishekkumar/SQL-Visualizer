import { useEffect } from 'react'
import { useUIStore } from '../../store/uiStore'

/**
 * Applies the persisted theme class to <html>. The app is dark-first;
 * the toggle switches to the light palette.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useUIStore((state) => state.theme)

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', theme === 'dark')
    // Keep the pre-bundle splash consistent with the chosen theme.
    root.querySelectorAll<HTMLElement>('#boot-splash').forEach((splash) => {
      splash.dataset.theme = theme
    })
  }, [theme])

  return <>{children}</>
}
