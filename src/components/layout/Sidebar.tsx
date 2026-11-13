import { useUIStore } from '../../store/uiStore'
import { DatabaseExplorer } from '../database/DatabaseExplorer'
import { SavedQueries } from '../history/SavedQueries'
import { QueryHistory } from '../history/QueryHistory'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { useHistoryStore } from '../../store/historyStore'
import { useState } from 'react'

/**
 * Left sidebar: database explorer, saved queries, query history.
 * On small screens it becomes an overlay drawer.
 */
export function Sidebar() {
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen)
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen)
  const clearAllHistory = useHistoryStore((state) => state.clearAllHistory)
  const [confirmClear, setConfirmClear] = useState(false)

  const content = (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <DatabaseExplorer />
      <div className="border-t border-border" />
      <SavedQueries />
      <div className="border-t border-border" />
      <QueryHistory onClearRequest={() => setConfirmClear(true)} />
    </div>
  )

  return (
    <>
      {/* Desktop: static panel */}
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border bg-bg-elevated md:flex">
        {content}
      </aside>

      {/* Mobile: overlay drawer */}
      {isSidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-bg-elevated shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-sm font-semibold text-text-primary">Workspace</span>
              <button
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
                className="rounded p-1 text-text-muted hover:text-text-primary"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1">{content}</div>
          </aside>
        </div>
      )}

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear query history"
      >
        <p className="text-sm text-text-secondary">
          Delete every history entry? Saved queries are not affected.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
          <Button
            variant="primary"
            className="!bg-danger hover:!bg-danger/85"
            onClick={async () => {
              await clearAllHistory()
              setConfirmClear(false)
            }}
          >
            Clear history
          </Button>
        </div>
      </Modal>
    </>
  )
}
