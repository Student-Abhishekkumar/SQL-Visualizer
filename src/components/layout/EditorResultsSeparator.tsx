import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'

const MIN_SPLIT = 20
const MAX_SPLIT = 80
const KEY_STEP = 2
const PAGE_STEP = 10

function clampRatio(value: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value))
}

interface EditorResultsSeparatorProps {
  value: number
  onChange: (value: number) => void
  boundsRef: RefObject<HTMLElement | null>
}

/**
 * Accessible vertical splitter between the editor (top) and results (bottom).
 *
 * The 8px bar is the visual affordance; a transparent child extends the hit
 * area vertically so the handle is comfortable to grab with a finger without
 * changing the layout. Drag, touch and keyboard all share the same clamp.
 */
export function EditorResultsSeparator({
  value,
  onChange,
  boundsRef,
}: EditorResultsSeparatorProps) {
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const roundedValue = Math.round(value)

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    const bounds = boundsRef.current?.getBoundingClientRect()
    if (bounds === undefined || bounds.height <= 0) return
    onChange(clampRatio(((event.clientY - bounds.top) / bounds.height) * 100))
  }

  const startDrag = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    // Keep keyboard focus on the handle so arrow keys work after a drag.
    event.currentTarget.focus({ preventScroll: true })
    draggingRef.current = true
    setDragging(true)
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Pointer capture is not available in every test environment.
    }
    updateFromPointer(event)
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId) === true) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // The browser may already have released capture on pointer cancellation.
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? PAGE_STEP : KEY_STEP
    let next: number | null = null
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        next = value - step
        break
      case 'ArrowDown':
      case 'ArrowRight':
        next = value + step
        break
      case 'PageUp':
        next = value - PAGE_STEP
        break
      case 'PageDown':
        next = value + PAGE_STEP
        break
      case 'Home':
        next = MIN_SPLIT
        break
      case 'End':
        next = MAX_SPLIT
        break
      default:
        return
    }
    event.preventDefault()
    onChange(clampRatio(next))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor and results"
      aria-controls="query-editor-region"
      aria-valuemin={MIN_SPLIT}
      aria-valuemax={MAX_SPLIT}
      aria-valuenow={roundedValue}
      aria-valuetext={`Editor ${roundedValue} percent, results ${100 - roundedValue} percent`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={startDrag}
      onPointerMove={updateFromPointer}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`group relative h-2 shrink-0 cursor-row-resize touch-none select-none transition-colors focus-visible:bg-accent/15 motion-reduce:transition-none ${
        dragging ? 'bg-accent/15' : 'bg-bg hover:bg-accent/10'
      }`}
    >
      {/* Expanded invisible hit area: 8px bar + 8px above and below. */}
      <div aria-hidden="true" className="absolute inset-x-0 -top-2 -bottom-2" />
      <div
        aria-hidden="true"
        className={`absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors motion-reduce:transition-none ${
          dragging
            ? 'bg-accent'
            : 'bg-border group-hover:bg-accent/60 group-focus-visible:bg-accent'
        }`}
      />
      <div
        aria-hidden="true"
        className={`absolute top-1/2 left-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors motion-reduce:transition-none ${
          dragging
            ? 'bg-accent'
            : 'bg-border-strong group-hover:bg-accent group-focus-visible:bg-accent'
        }`}
      />
    </div>
  )
}