/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')

function themeBlock(startMarker: string, endMarker: string): string {
  const start = css.indexOf(startMarker)
  const end = css.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

function token(block: string, name: string): string {
  const value = block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
  expect(value, `Missing ${name}`).toBeDefined()
  return value!
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(value: string): Rgba {
  const trimmed = value.trim()
  if (trimmed.startsWith('#')) {
    let hex = trimmed.slice(1)
    if (hex.length === 3) hex = hex.split('').map((channel) => channel + channel).join('')
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: 1,
    }
  }
  const match = trimmed.match(/rgba?\(([^)]+)\)/)
  if (!match) throw new Error(`Unsupported colour: ${value}`)
  const parts = match[1]!.split(',').map((part) => Number(part.trim()))
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 }
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a + background.a * (1 - foreground.a)
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  }
}

/** Composite translucent colours over the app's dark page base. */
const PAGE_BASE: Rgba = { r: 11, g: 18, b: 32, a: 1 }

function luminance(value: string): number {
  const color = composite(parseColor(value), PAGE_BASE)
  const channels = [color.r, color.g, color.b].map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const themeIds = [
  'midnight',
  'dracula',
  'nord',
  'solarized-dark',
  'glassy',
  'bloody',
  'cyberpunk',
] as const

const themes: Array<[string, string]> = [
  ['light', themeBlock(':root {', '\n.dark {')],
  ['dark', themeBlock('\n.dark {', "[data-theme='midnight']")],
  ...themeIds.map(
    (id) => [id, themeBlock(`[data-theme='${id}'] {`, '\n}')] as [string, string],
  ),
]

const surfaces = ['--bg', '--bg-elevated', '--surface', '--surface-2', '--surface-3']
const textAccents = ['--accent', '--violet', '--cyan', '--success', '--warning', '--danger']

describe('design token contrast', () => {
  it('defines all nine themes', () => {
    expect(themes).toHaveLength(9)
  })

  it.each(themes)('%s theme meets AA text contrast on every core surface', (_, block) => {
    for (const foreground of ['--text-primary', '--text-secondary', '--text-muted', ...textAccents]) {
      for (const surface of surfaces) {
        const ratio = contrast(token(block, foreground), token(block, surface))
        expect(
          ratio,
          `${foreground} on ${surface}: ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it.each(themes)('%s theme has accessible action, focus and control colors', (_, block) => {
    for (const action of ['--accent', '--accent-hover']) {
      expect(contrast(token(block, '--accent-ink'), token(block, action))).toBeGreaterThanOrEqual(4.5)
    }
    for (const surface of surfaces) {
      expect(contrast(token(block, '--focus-ring'), token(block, surface))).toBeGreaterThanOrEqual(3)
      expect(contrast(token(block, '--control-border'), token(block, surface))).toBeGreaterThanOrEqual(3)
    }
  })
})