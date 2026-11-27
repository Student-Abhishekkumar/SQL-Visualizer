interface CanvasLoadingMarkProps {
  label: string
  className?: string
}

/**
 * Compact lazy-loading indicator: a miniature two-node canvas with a live
 * wire, using the same visual language as the full-screen loading canvas.
 * Shown inside Suspense fallbacks for the editor and the Canvas workspace.
 */
export function CanvasLoadingMark({ label, className = '' }: CanvasLoadingMarkProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      className={`cl-compact ${className}`.trim()}
    >
      <span className="cl-compact__mark" aria-hidden="true">
        <svg viewBox="0 0 36 22" className="cl-mark" focusable="false">
          <path className="cl-mark__wire" d="M9 6 C 18 6 16 16 27 16" pathLength={1} />
          <rect className="cl-mark__node cl-mark__node--a" x="1.5" y="1.5" width="10" height="9" rx="2.5" />
          <rect className="cl-mark__node cl-mark__node--b" x="24.5" y="11.5" width="10" height="9" rx="2.5" />
          <circle className="cl-mark__dot" cx="18" cy="11" r="1.5" />
        </svg>
      </span>
      <span className="cl-compact__label">{label}</span>
    </div>
  )
}