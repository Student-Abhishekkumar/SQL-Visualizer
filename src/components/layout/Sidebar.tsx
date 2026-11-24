import { useEffect, useRef, useState } from 'react'
import { PanelLeft, X } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import { DatabaseExplorer } from '../database/DatabaseExplorer'
import { SavedQueries } from '../history/SavedQueries'
import { QueryHistory } from '../history/QueryHistory'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { useHistoryStore } from '../../store/historyStore'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(drawer: HTMLElement): HTMLElement[] {
  return Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hidden &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.closest('[hidden], [inert]') === null,
  )
}

/** Keep the drawer mounted through its exit animation before unmounting. */
const DRAWER_EXIT_MS = 200

/** Database, saved-query and history navigation with an accessible mobile drawer. */
export function Sidebar() {
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen)
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen)
  const clearAllHistory = useHistoryStore((state) => state.clearAllHistory)
  const [confirmClear, setConfirmClear] = useState(false)
  const [drawerMounted, setDrawerMounted] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // Mount during render so the drawer is present in the same commit that
  // opens it. The exit path below keeps it alive for the closing animation.
  if (isSidebarOpen && !drawerMounted) {
    setDrawerMounted(true)
  }

  useEffect(() => {
    if (isSidebarOpen) return undefined
    const timeout = window.setTimeout(() => setDrawerMounted(false), DRAWER_EXIT_MS)
    return () => window.clearTimeout(timeout)
  }, [isSidebarOpen])

  // Closing at the desktop breakpoint prevents a hidden drawer from leaving
  // the main workspace inert after a device rotation or window resize.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktop = window.matchMedia('(min-width: 1024px)')
    const closeAtDesktop = () => {
      if (desktop.matches) setSidebarOpen(false)
    }
    closeAtDesktop()
    desktop.addEventListener('change', closeAtDesktop)
    return () => desktop.removeEventListener('change', closeAtDesktop)
  }, [setSidebarOpen])

  useEffect(() => {
    if (!isSidebarOpen || !drawerMounted) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      const drawer = drawerRef.current
      if (drawer === null || !(event.target instanceof Node) || !drawer.contains(event.target)) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setSidebarOpen(false)
        return
      }
      if (event.key !== 'Tab') return

      const focusable = focusableElements(drawer)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) {
        event.preventDefault()
        drawer.focus({ preventScroll: true })
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected === true) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [isSidebarOpen, drawerMounted, setSidebarOpen])

  const content = (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="flex min-h-full flex-col">
        <section aria-label="Database explorer" className="flex min-h-56 flex-[1.15] flex-col">
          <DatabaseExplorer />
        </section>
        <section aria-label="Saved queries" className="shrink-0 border-t border-separator py-0.5">
          <SavedQueries />
        </section>
        <section
          aria-label="Query history"
          className="flex min-h-40 flex-1 flex-col border-t border-separator"
        >
          <QueryHistory onClearRequest={() => setConfirmClear(true)} />
        </section>
      </div>
    </div>
  )

  const workspaceLabel = (
    <div className="flex items-center gap-2">
      <PanelLeft className="size-4 text-accent" aria-hidden="true" />
      <span className="text-xs font-semibold tracking-[0.08em] text-text-secondary uppercase">
        Workspace
      </span>
    </div>
  )

  return (
    <>
      <aside
        aria-label="Workspace navigation"
        className="glass-surface hidden w-72 shrink-0 flex-col border-r border-border bg-bg-elevated lg:flex xl:w-80"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-separator px-3">
          {workspaceLabel}
          <span className="hidden text-[11px] text-text-muted xl:inline">Local session</span>
        </div>
        <div className="min-h-0 flex-1">{content}</div>
      </aside>

      {drawerMounted && (
        <div
          aria-hidden={isSidebarOpen ? undefined : true}
          className={`fixed inset-0 z-40 lg:hidden ${isSidebarOpen ? '' : 'pointer-events-none'}`}
        >
          <div
            data-drawer-backdrop=""
            aria-hidden="true"
            onPointerDown={(event) => {
              if (event.button === 0) setSidebarOpen(false)
            }}
            className={`absolute inset-0 bg-black/60 backdrop-blur-[2px] motion-reduce:backdrop-blur-none ${
              isSidebarOpen ? 'drawer-backdrop-open' : 'drawer-backdrop-closed'
            }`}
          />
          <aside
            ref={drawerRef}
            id="workspace-sidebar"
            role="dialog"
            aria-modal={isSidebarOpen ? 'true' : undefined}
            aria-labelledby="workspace-sidebar-title"
            aria-describedby="workspace-sidebar-description"
            tabIndex={-1}
            data-drawer-panel=""
            className={`glass-surface absolute inset-y-0 left-0 flex w-[min(20rem,calc(100vw-1rem))] max-w-full flex-col border-r border-border bg-bg-elevated shadow-window ${
              isSidebarOpen ? 'drawer-panel-open' : 'drawer-panel-closed'
            }`}
          >
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-separator px-3">
              <div id="workspace-sidebar-title">{workspaceLabel}</div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close navigation"
                className="inline-flex size-11 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <p id="workspace-sidebar-description" className="sr-only">
              Database explorer, saved queries and query history.
            </p>
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