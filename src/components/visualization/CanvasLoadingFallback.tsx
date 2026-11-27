import { CanvasLoadingMark } from '../common/CanvasLoadingMark'
import { Skeleton } from '../common/Skeleton'

/**
 * Canvas-shaped placeholder shown while the lazy visualization bundle loads.
 * `.lazy-fade` prevents a flash for very fast loads. The compact canvas mark
 * in the header keeps the loading language consistent with the startup screen.
 */
export function CanvasLoadingFallback() {
  return (
    <div className="lazy-fade flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <CanvasLoadingMark label="Loading canvas…" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      <div className="grid flex-1 grid-cols-2 gap-4 p-6 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-lg" />
        ))}
      </div>
    </div>
  )
}