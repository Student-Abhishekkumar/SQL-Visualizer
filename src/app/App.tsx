import { useEffect } from 'react'
import { DatabaseZap } from 'lucide-react'
import { ThemeProvider } from './providers/ThemeProvider'
import { MainLayout } from '../components/layout/MainLayout'
import { ErrorState } from '../components/common/ErrorState'
import { AppLoadingScreen } from '../components/common/AppLoadingScreen'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import { browserSqlJsConfig } from '../services/database/wasmConfig'

/**
 * Application root. Shows the branded startup experience while SQLite
 * initializes, the existing error state on failure, and the workspace once
 * the engine is ready. ThemeProvider wraps every state so the loader, error
 * screen and app all follow the selected theme.
 */
export function App() {
  const status = useDatabaseStore((state) => state.status)
  const initError = useDatabaseStore((state) => state.initError)
  const initialize = useDatabaseStore((state) => state.initialize)

  useEffect(() => {
    void initialize(browserSqlJsConfig)
    void useHistoryStore.getState().loadFromStorage()
  }, [initialize])

  return (
    <ThemeProvider>
      {status === 'error' ? (
        <div className="h-full bg-bg">
          <ErrorState
            icon={<DatabaseZap className="size-6" />}
            title="Failed to initialize the database"
            headingLevel={1}
            description={initError ?? 'The database engine could not be started.'}
            onRetry={() => void initialize(browserSqlJsConfig)}
          />
        </div>
      ) : status === 'ready' ? (
        <MainLayout />
      ) : (
        <AppLoadingScreen status={status} />
      )}
    </ThemeProvider>
  )
}