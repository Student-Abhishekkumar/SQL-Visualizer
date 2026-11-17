import { ScanSearch, X } from 'lucide-react'
import { Tooltip } from '../../common/Tooltip'
import type { FlowGraphNode } from '../../../types/flowGraph'
import { accentColor, nodeAccentKey } from './nodeAccent'

/**
 * Minimized-inspector dock.
 *
 * A minimized inspector is not allowed to silently disappear: this
 * compact item keeps the selected node's identity visible and restores
 * the same workspace-owned window (position, size, mode and active tab).
 * The dock is pointer-transparent except for its own controls, so it can
 * never swallow a canvas pan or node drag.
 */

interface FloatingInspectorDockProps {
  node: FlowGraphNode
  onRestore: () => void
  onClose: () => void
}

export function FloatingInspectorDock({
  node,
  onRestore,
  onClose,
}: FloatingInspectorDockProps) {
  const accent = accentColor(nodeAccentKey(node))

  return (
    <div
      data-testid="inspector-dock"
      role="region"
      aria-label="Minimized inspectors"
      className="pointer-events-none absolute bottom-3 left-3 z-40 flex max-w-[min(22rem,calc(100%-1.5rem))]"
    >
      <div className="inspector-dock-item pointer-events-auto flex min-w-0 items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-1 shadow-panel ring-1 ring-black/5 backdrop-blur-sm">
        <Tooltip label={`Restore inspector for ${node.label}`} side="top">
          <button
            type="button"
            aria-label={`Restore inspector for ${node.label}`}
            onClick={onRestore}
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <span
              className="grid size-6 shrink-0 place-items-center rounded-md"
              style={{
                color: accent,
                background: `color-mix(in srgb, ${accent} 14%, transparent)`,
              }}
              aria-hidden
            >
              <ScanSearch className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[11px] font-medium text-text-primary">
                {node.label}
              </span>
              <span className="block text-[9px] tracking-wide text-text-muted uppercase">
                Inspector minimized
              </span>
            </span>
          </button>
        </Tooltip>
        <Tooltip label="Close minimized inspector" side="top">
          <button
            type="button"
            aria-label="Close minimized inspector"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
