import { useCallback, useEffect, useState } from 'react'

export type AppRoute = 'home' | 'app'

/**
 * Reads the workspace route from the URL hash.
 *
 * The homepage lives at `/` (no hash). The workspace lives at `#/app`.
 * Any other hash — in-page anchors such as `#method` or the workspace's
 * own `#main-workspace` skip link — is ignored so it never flips the
 * route. This keeps the cinematic homepage and the real application as
 * two separate presentations of the same bundle.
 */
function routeFromHash(hash: string): AppRoute | null {
  if (hash === '#/app') return 'app'
  if (hash === '' || hash === '#' || hash === '#/') return 'home'
  return null
}

function currentRoute(): AppRoute {
  return routeFromHash(window.location.hash) ?? 'home'
}

export function useHashRoute(): [AppRoute, (route: AppRoute) => void] {
  const [route, setRoute] = useState<AppRoute>(currentRoute)

  useEffect(() => {
    const onHashChange = () => {
      const next = routeFromHash(window.location.hash)
      if (next !== null) setRoute(next)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigate = useCallback((next: AppRoute) => {
    const target = next === 'app' ? '#/app' : '#/'
    if (window.location.hash === target) {
      setRoute(next)
      return
    }
    // Assigning the hash pushes a history entry, so Back returns to the
    // homepage. The hashchange listener updates the route.
    window.location.hash = target
  }, [])

  return [route, navigate]
}