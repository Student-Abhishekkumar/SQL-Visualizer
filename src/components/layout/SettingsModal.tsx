import { useState } from 'react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { TriangleAlert } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { useDatabaseStore } from '../../store/databaseStore'
import { useHistoryStore } from '../../store/historyStore'
import { getActiveDatabase, getLiveDatabase } from '../../services/database/databaseManager'

interface SettingsModalProps {
  open: boolean
}

/** Settings: theme, database reset, history maintenance, engine info. */
export function SettingsModal({ open }: SettingsModalProps) {
  const theme = useUIStore((state) => state.theme)
  const toggleTheme = useUIStore((state) => state.toggleTheme)
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<'reset' | 'clear' | null>(null)

  const reset = useDatabaseStore((state) => state.resetDatabase)
  const clearAllHistory = useHistoryStore((state) => state.clearAllHistory)
  const sqliteVersion = getLiveDatabase()?.sqliteVersion() ?? null
  const activeDatabase = getActiveDatabase()

  const handleReset = async () => {
    setBusy('reset')
    try {
      await reset()
      setStatus(
        activeDatabase ? `“${activeDatabase.name}” reset to its starting state.` : 'Database reset.',
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Reset failed.')
    } finally {
      setBusy(null)
      setConfirmReset(false)
    }
  }

  const handleClearHistory = async () => {
    setBusy('clear')
    await clearAllHistory()
    setBusy(null)
    setConfirmClear(false)
    setStatus('Query history cleared.')
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        setSettingsOpen(false)
        setConfirmReset(false)
        setConfirmClear(false)
      }}
      title="Settings"
    >
      <div>
        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Appearance
          </h3>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((option) => (
              <button
                key={option}
                onClick={() => {
                  if (theme !== option) toggleTheme()
                }}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-colors ${
                  theme === option
                    ? 'border-accent bg-accent-soft text-text-primary'
                    : 'border-border text-text-secondary hover:border-border-strong'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            Database
          </h3>
          <p className="mb-2 text-[13px] leading-relaxed text-text-secondary">
            SQLite {sqliteVersion ?? '—'} running locally in your browser.
            {activeDatabase
              ? ` Reset returns “${activeDatabase.name}” to its template state.`
              : ' No database is currently open.'}
          </p>
          {confirmReset ? (
            <div className="rounded-lg border border-danger/40 bg-danger-soft p-3">
              <p className="text-[13px] text-danger">
                All changes will be discarded. This cannot be undone.
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" onClick={() => setConfirmReset(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" loading={busy === 'reset'} onClick={() => void handleReset()} className="!bg-danger hover:!bg-danger/85">
                  Confirm reset
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger" icon={<TriangleAlert className="size-3.5" />} onClick={() => setConfirmReset(true)}>
              Reset database
            </Button>
          )}
        </section>

        <section className="mt-5">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
            History
          </h3>
          <p className="mb-2 text-[12px] leading-relaxed text-text-secondary">
            History is kept per database; the sidebar filters it to the active
            database by default.
          </p>
          {confirmClear ? (
            <div className="rounded-lg border border-danger/40 bg-danger-soft p-3">
              <p className="text-[13px] text-danger">
                Delete every history entry?
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <Button size="sm" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" loading={busy === 'clear'} onClick={() => void handleClearHistory()} className="!bg-danger hover:!bg-danger/85">
                  Confirm
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmClear(true)}>
              Clear query history
            </Button>
          )}
        </section>

        {status && <p className="mt-4 text-xs text-success">{status}</p>}
      </div>
    </Modal>
  )
}
