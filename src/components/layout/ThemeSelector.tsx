import { useRef, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import {
  CLASSIC_THEMES,
  VISUAL_THEMES,
  type ThemeDefinition,
} from '../../theme/themes'

const ALL_THEMES = [...CLASSIC_THEMES, ...VISUAL_THEMES]

/**
 * Accessible nine-theme picker: a radiogroup with roving tabindex, arrow-key
 * navigation, grouped into Classic and Visual Styles, with a colour preview
 * and a clear active indicator.
 */
export function ThemeSelector() {
  const theme = useUIStore((state) => state.theme)
  const setTheme = useUIStore((state) => state.setTheme)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (index + 1) % ALL_THEMES.length
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + ALL_THEMES.length) % ALL_THEMES.length
    }
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = ALL_THEMES.length - 1
    if (next === null) return

    event.preventDefault()
    const nextTheme = ALL_THEMES[next]
    if (nextTheme === undefined) return
    setTheme(nextTheme.id)
    refs.current[next]?.focus({ preventScroll: true })
  }

  const renderTheme = (definition: ThemeDefinition, currentIndex: number) => {
    const active = theme === definition.id
    return (
      <button
        key={definition.id}
        ref={(element) => {
          refs.current[currentIndex] = element
        }}
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={`${definition.name} theme`}
        tabIndex={active ? 0 : -1}
        title={definition.description}
        onClick={() => setTheme(definition.id)}
        onKeyDown={(event) => onKeyDown(event, currentIndex)}
        className={`group relative flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none ${
          active
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-surface-2 hover:border-border-strong'
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-9 overflow-hidden rounded-md border border-border"
          style={{ background: definition.preview.bg }}
        >
          <span className="h-full w-1/4" style={{ background: definition.preview.surface }} />
          <span className="h-full w-1/4" style={{ background: definition.preview.accent }} />
          <span className="h-full w-1/4" style={{ background: definition.preview.text }} />
          <span className="h-full flex-1" style={{ background: definition.preview.bg }} />
        </span>
        <span className="flex items-center justify-between gap-1">
          <span className="truncate text-[11px] font-medium text-text-primary">
            {definition.name}
          </span>
          {active && <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />}
        </span>
      </button>
    )
  }

  return (
    <div role="radiogroup" aria-label="Color theme" className="space-y-3">
      <section>
        <h3
          id="theme-classic-heading"
          className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Classic
        </h3>
        <div
          role="group"
          aria-labelledby="theme-classic-heading"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {CLASSIC_THEMES.map((definition, index) => renderTheme(definition, index))}
        </div>
      </section>

      <section>
        <h3
          id="theme-visual-heading"
          className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
        >
          Visual Styles
        </h3>
        <div
          role="group"
          aria-labelledby="theme-visual-heading"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {VISUAL_THEMES.map((definition, index) =>
            renderTheme(definition, CLASSIC_THEMES.length + index),
          )}
        </div>
      </section>
    </div>
  )
}