import { Database } from 'lucide-react'

interface AppLoadingScreenProps {
  status: 'uninitialized' | 'initializing'
}

const MESSAGES = {
  uninitialized: { detail: 'Preparing your local workspace…' },
  initializing: { detail: 'Starting the SQLite engine…' },
} as const

/**
 * Full-screen startup experience shown while the SQLite engine initializes.
 * The animation is decorative; the live status text carries the meaning.
 */
export function AppLoadingScreen({ status }: AppLoadingScreenProps) {
  const message = MESSAGES[status]
  return (
    <div className="app-loader flex h-full min-h-0 flex-col items-center justify-center gap-6 bg-bg px-6 text-center">
      <div className="app-loader__glow" aria-hidden="true" />
      <div className="app-loader__mark" aria-hidden="true">
        <Database className="size-7" />
      </div>
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-muted">
          Local SQL workspace
        </p>
        <h1 className="text-lg font-semibold tracking-tight text-text-primary">
          SQL Visualizer
        </h1>
        <p className="text-[13px] text-text-muted">{message.detail}</p>
      </div>
      <div className="app-loader__lines" aria-hidden="true">
        <span className="app-loader__line" />
        <span className="app-loader__line" />
        <span className="app-loader__line" />
      </div>
      <div
        className="app-loader__bar"
        role="progressbar"
        aria-label="Loading SQL Visualizer"
        aria-valuetext={message.detail}
      >
        <span />
      </div>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message.detail}
      </span>
    </div>
  )
}