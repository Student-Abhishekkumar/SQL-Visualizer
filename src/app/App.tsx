import { useCallback, useEffect, useRef, useState } from 'react'
import { DatabaseZap } from 'lucide-react'
import { ThemeProvider } from './providers/ThemeProvider'
import { MainLayout } from '../components/layout/MainLayout'
import { ErrorState } from '../components/common/ErrorState'
import { AppLoadingScreen } from '../components/common/AppLoadingScreen'
import { HomePage } from '../components/home/HomePage'
import { WebsiteEntranceGate } from '../components/home/WebsiteEntranceGate'
import { useHashRoute } from './useHashRoute'
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import { browserSqlJsConfig } from '../services/database/wasmConfig'

const EXIT_MS = 250

/**
 * Application root.
 *
 * Two presentations share one bundle:
 *  - `#/`   the public cinematic homepage (see HomePage)
 *  - `#/app` the real workspace, which keeps its branded startup loader,
 *            error state and everything the app already did.
 *
 * SQLite initialisation is intentionally deferred to the workspace route so
 * the homepage never waits on (or is coupled to) the database engine. The
 * homepage can warm the engine on intent so entering feels instant.
 *
 * When the engine becomes ready the workspace mounts immediately and the
 * living canvas plays a short (300ms) push-out above it with pointer events
 * disabled, so the cinematic canvas becomes the product without ever
 * delaying access.
 */
export function App() {
  const [route, navigate] = useHashRoute()
  const status = useDatabaseStore((state) => state.status)
  const initError = useDatabaseStore((state) => state.initError)
  const initialize = useDatabaseStore((state) => state.initialize)
  const reducedMotion = usePrefersReducedMotion()
  const bootedRef = useRef(false)
  const [seenStatus, setSeenStatus] = useState(status)
  const [exiting, setExiting] = useState(false)

  // Detect the transition into "ready" during render so the exit overlay is
  // present on the same commit that mounts the workspace (the loader keeps
  // the same tree position, so its animation never restarts).
  if (status !== seenStatus) {
    setSeenStatus(status)
    setExiting(status === 'ready' && route === 'app' && !reducedMotion)
  }

  useEffect(() => {
    if (!exiting) return
    const timer = window.setTimeout(() => setExiting(false), EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [exiting])

  const boot = useCallback(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void initialize(browserSqlJsConfig)
    void useHistoryStore.getState().loadFromStorage()
  }, [initialize])

  useEffect(() => {
    if (route === 'app') boot()
  }, [route, boot])

  return (
    <ThemeProvider>
      {route === 'home' ? (
        <WebsiteEntranceGate>
          <HomePage onEnter={() => navigate('app')} onWarm={boot} />
        </WebsiteEntranceGate>
      ) : status === 'error' ? (
        <div className="h-full bg-bg">
          <ErrorState
            icon={<DatabaseZap className="size-6" />}
            title="Failed to initialize the database"
            headingLevel={1}
            description={initError ?? 'The database engine could not be started.'}
            onRetry={() => {
              bootedRef.current = true
              void initialize(browserSqlJsConfig)
            }}
          />
        </div>
      ) : (
        <>
          {status === 'ready' && <MainLayout />}
          {(status !== 'ready' || exiting) && (
            <AppLoadingScreen
              status={status === 'ready' ? 'initializing' : status}
              exiting={exiting}
            />
          )}
        </>
      )}
    </ThemeProvider>
  )
}
