import { useEffect } from 'react'
import { useUIStore } from '../../store/uiStore'
import { themeMode } from '../../theme/themes'

/**
 * Applies the selected theme to <html>: a `data-theme` attribute for the
 * CSS palette, the `dark` class for Tailwind's dark variants, the native
 * `color-scheme`, and the optional reduced-effects class.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useUIStore((state) => state.theme)
  const reducedEffects = useUIStore((state) => state.reducedEffects)
  const mode = themeMode(theme)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    root.classList.toggle('dark', mode === 'dark')
    root.style.colorScheme = mode
    root.classList.toggle('reduce-effects', reducedEffects)
    // Keep the pre-bundle splash consistent with the chosen theme.
    root.querySelectorAll<HTMLElement>('#boot-splash').forEach((splash) => {
      splash.dataset.theme = mode
    })
  }, [theme, mode, reducedEffects])

  return <>{children}</>
}