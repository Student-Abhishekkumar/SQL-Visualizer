import { LoadingState } from '../common/LoadingState'
import { Skeleton } from '../common/Skeleton'

/**
 * Editor-shaped placeholder shown while the lazy Monaco bundle loads.
 * `.lazy-fade` keeps it invisible for very fast loads so it never flashes.
 */
export function EditorLoadingFallback() {
  return (
    <div className="lazy-fade flex h-full min-h-0 w-full flex-col gap-2 bg-surface p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex-1 space-y-2 pt-1">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-2/5" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <LoadingState label="Loading editor…" size="sm" className="justify-start" />
    </div>
  )
}