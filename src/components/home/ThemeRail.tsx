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
 * Landing-page theme rail. A real radiogroup wired to the shared UI store,
 * so a choice made here carries straight into the workspace. Selecting a
 * theme restyles the entire homepage live — the most honest possible
 * preview of each palette.
 */
export function ThemeRail() {
  const theme = useUIStore((state) => state.theme)
  const setTheme = useUIStore((state) => state.setTheme)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (index + 1) % ALL_THEMES.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (index - 1 + ALL_THEMES.length) % ALL_THEMES.length
    } else if (event.key === 'Home') {
      next = 0
    } else if (event.key === 'End') {
      next = ALL_THEMES.length - 1
    }
    if (next === null) return
    event.preventDefault()
    const target = ALL_THEMES[next]
    if (!target) return
    setTheme(target.id)
    refs.current[next]?.focus({ preventScroll: true })
  }

  const renderTheme = (definition: ThemeDefinition, index: number) => {
    const active = theme === definition.id
    return (
      <button
        key={definition.id}
        ref={(element) => {
          refs.current[index] = element
        }}
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={`${definition.name} theme`}
        tabIndex={active ? 0 : -1}
        title={definition.description}
        onClick={() => setTheme(definition.id)}
        onKeyDown={(event) => onKeyDown(event, index)}
        className={`home-theme group ${active ? 'is-active' : ''}`}
      >
        <span aria-hidden="true" className="home-theme__swatch">
          <span style={{ background: definition.preview.bg }} />
          <span style={{ background: definition.preview.surface }} />
          <span style={{ background: definition.preview.accent }} />
          <span style={{ background: definition.preview.text }} />
        </span>
        <span className="home-theme__meta">
          <span className="home-theme__name">{definition.name}</span>
          {active ? (
            <Check className="home-theme__check" aria-hidden="true" />
          ) : (
            <span className="home-theme__hint">{definition.group === 'visual' ? 'Style' : 'Classic'}</span>
          )}
        </span>
      </button>
    )
  }

  return (
    <div role="radiogroup" aria-label="Color theme" className="home-theme-rail">
      <div className="home-theme-rail__group">
        <span className="home-theme-rail__label">Classic</span>
        <div role="group" aria-label="Classic themes" className="home-theme-rail__grid">
          {CLASSIC_THEMES.map((definition, index) => renderTheme(definition, index))}
        </div>
      </div>
      <div className="home-theme-rail__group">
        <span className="home-theme-rail__label">Visual styles</span>
        <div role="group" aria-label="Visual style themes" className="home-theme-rail__grid">
          {VISUAL_THEMES.map((definition, index) =>
            renderTheme(definition, CLASSIC_THEMES.length + index),
          )}
        </div>
      </div>
    </div>
  )
}