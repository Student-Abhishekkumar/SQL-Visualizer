import { useEffect } from 'react'
import { DatabaseZap, RefreshCw } from 'lucide-react'
import { ThemeProvider } from './providers/ThemeProvider'
import { MainLayout } from '../components/layout/MainLayout'
import { useDatabaseStore } from '../store/databaseStore'
import { useHistoryStore } from '../store/historyStore'
import { browserSqlJsConfig } from '../services/database/wasmConfig'
import { Button } from '../components/common/Button'

/**
 * Application root. Bootstraps the SQLite WASM engine and history
 * persistence, shows splash/error states, then renders the workspace.
 */
export function App() {
  const status = useDatabaseStore((state) => state.status)
  const initError = useDatabaseStore((state) => state.initError)
  const initialize = useDatabaseStore((state) => state.initialize)

  useEffect(() => {
    void initialize(browserSqlJsConfig)
    void useHistoryStore.getState().loadFromStorage()
  }, [initialize])

  if (status === 'error') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-bg p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-danger-soft text-danger">
          <DatabaseZap className="size-6" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">
            Failed to initialize the database
          </h1>
          <p className="mt-1 max-w-md text-sm text-text-secondary">
            {initError}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<RefreshCw className="size-3.5" />}
          onClick={() => void initialize(browserSqlJsConfig)}
        >
          Retry
        </Button>
      </div>
    )
  }

  return (
    <ThemeProvider>
      <MainLayout />
    </ThemeProvider>
  )
}
