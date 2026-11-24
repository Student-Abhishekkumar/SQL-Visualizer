import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Palette } from 'lucide-react'
import { useUIStore } from '../../store/uiStore'
import {
  CLASSIC_THEMES,
  VISUAL_THEMES,
  themeById,
  type ThemeDefinition,
  type ThemeId,
} from '../../theme/themes'

/**
 * Compact nine-theme dropdown for the top navigation.
 *
 * The panel is fixed-positioned from the trigger's rect so it stays inside
 * the viewport on mobile, and it supports arrow-key navigation, Escape,
 * outside-click dismissal and focus restoration.
 */
export function ThemeMenu() {
  const theme = useUIStore((state) => state.theme)
  const setTheme = useUIStore((state) => state.setTheme)
  const current = themeById(theme)

  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 8, top: 0, width: 288, maxHeight: 400 })
  const wrapperRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const menuItems = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])

  const updatePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(288, window.innerWidth - 16)
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const top = rect.bottom + 6
    const maxHeight = Math.max(180, window.innerHeight - top - 8)
    setPosition({ left, top, width, maxHeight })
  }

  const openMenu = () => {
    updatePosition()
    setOpen(true)
  }

  const closeMenu = (returnFocus: boolean) => {
    setOpen(false)
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true })
  }

  const selectTheme = (id: ThemeId) => {
    setTheme(id)
    closeMenu(true)
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) closeMenu(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeMenu(true)
      }
    }
    const onResize = () => updatePosition()
    window.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const items = menuItems()
    const activeIndex = items.findIndex((item) => item.getAttribute('aria-checked') === 'true')
    items[activeIndex >= 0 ? activeIndex : 0]?.focus({ preventScroll: true })
  }, [open])

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openMenu()
        return
      }
      const items = menuItems()
      const activeIndex = items.findIndex((item) => item.getAttribute('aria-checked') === 'true')
      items[activeIndex >= 0 ? activeIndex : 0]?.focus()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) closeMenu(true)
      else openMenu()
    }
  }

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = menuItems()
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        items[(index + 1 + items.length) % items.length]?.focus()
        break
      case 'ArrowUp':
        event.preventDefault()
        items[(index - 1 + items.length) % items.length]?.focus()
        break
      case 'Home':
        event.preventDefault()
        items[0]?.focus()
        break
      case 'End':
        event.preventDefault()
        items[items.length - 1]?.focus()
        break
      case 'Tab':
        closeMenu(false)
        break
      default:
        break
    }
  }

  const renderItem = (definition: ThemeDefinition) => {
    const active = theme === definition.id
    return (
      <button
        key={definition.id}
        type="button"
        role="menuitemradio"
        aria-checked={active}
        tabIndex={-1}
        title={definition.description}
        onClick={() => selectTheme(definition.id)}
        className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none sm:min-h-0 ${
          active
            ? 'bg-accent-soft text-text-primary'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
        }`}
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-9 shrink-0 overflow-hidden rounded border border-border"
          style={{ background: definition.preview.bg }}
        >
          <span className="h-full w-1/3" style={{ background: definition.preview.surface }} />
          <span className="h-full w-1/3" style={{ background: definition.preview.accent }} />
          <span className="h-full flex-1" style={{ background: definition.preview.text }} />
        </span>
        <span className="min-w-0 flex-1 truncate">{definition.name}</span>
        {active && <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />}
      </button>
    )
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="theme-menu"
        aria-label={`Theme: ${current.name}`}
        title={`Theme: ${current.name}`}
        onClick={() => {
          if (open) closeMenu(true)
          else openMenu()
        }}
        onKeyDown={onButtonKeyDown}
        className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none sm:h-9"
      >
        <Palette className="size-3.5 text-accent" aria-hidden="true" />
        <span className="hidden sm:inline">{current.name}</span>
        <ChevronDown
          className={`size-3 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          id="theme-menu"
          role="menu"
          aria-label="Themes"
          onKeyDown={onMenuKeyDown}
          style={{
            position: 'fixed',
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          className="z-50 overflow-y-auto rounded-xl border border-border bg-bg-elevated p-1.5 shadow-window"
        >
          <div role="group" aria-labelledby="theme-menu-classic">
            <div
              id="theme-menu-classic"
              className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
            >
              Classic
            </div>
            {CLASSIC_THEMES.map(renderItem)}
          </div>
          <div role="group" aria-labelledby="theme-menu-visual" className="mt-1">
            <div
              id="theme-menu-visual"
              className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
            >
              Visual Styles
            </div>
            {VISUAL_THEMES.map(renderItem)}
          </div>
        </div>
      )}
    </div>
  )
}