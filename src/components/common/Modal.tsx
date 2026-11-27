import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  /** Extra width for content-heavy dialogs. */
  wide?: boolean
  /** Widest layout for the database manager (two-column). */
  extraWide?: boolean
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(panel: HTMLDivElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hidden &&
      element.getAttribute('aria-hidden') !== 'true' &&
      element.closest('[hidden], [inert]') === null,
  )
}

/** Modal dialog with focus containment, Escape/backdrop close and focus restoration. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
  extraWide = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (panel === null) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Respect an intentional autoFocus inside the dialog. Otherwise focus the
    // first control, falling back to the titled dialog panel itself.
    if (!(document.activeElement instanceof HTMLElement) || !panel.contains(document.activeElement)) {
      const initialFocus =
        panel.querySelector<HTMLElement>('[data-modal-initial-focus]') ??
        focusableElements(panel)[0] ??
        panel
      initialFocus.focus({ preventScroll: true })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = focusableElements(panel)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) {
        event.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }

      const active = document.activeElement
      const focusIsInside = active instanceof HTMLElement && panel.contains(active)
      if (event.shiftKey && (active === first || active === panel || !focusIsInside)) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === last || !focusIsInside)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (previousFocus?.isConnected === true) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [open])

  if (!open) return null

  // Portalled to the document root so dialogs always paint above canvas
  // overlays (for example the floating node inspector) regardless of where
  // the trigger lives in the component tree.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px] motion-reduce:backdrop-blur-none"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        tabIndex={-1}
        className={`modal-panel glass-surface flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-window ${
          extraWide ? 'max-w-4xl' : wide ? 'max-w-2xl' : 'max-w-md'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary motion-reduce:transition-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto px-4 py-4">
          {description !== undefined && (
            <div id={descriptionId} className="mb-3 text-sm leading-relaxed text-text-secondary">
              {description}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
