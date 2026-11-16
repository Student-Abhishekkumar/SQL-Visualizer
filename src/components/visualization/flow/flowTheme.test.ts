import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NODE_ACCENT_KEYS } from './nodeAccent'

/**
 * Light/dark completeness for the flow canvas. The canvas itself only
 * references CSS custom properties, so both theme blocks must define
 * every operation accent used by nodes, sockets, wires and markers.
 */

const css = readFileSync(new URL('../../../index.css', import.meta.url), 'utf8')

function themeBlock(startMarker: string, endMarker: string): string {
  const start = css.indexOf(startMarker)
  const end = css.indexOf(endMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return css.slice(start, end)
}

const lightTheme = themeBlock(':root {', '\n.dark {')
const darkTheme = themeBlock('\n.dark {', '@theme inline')

describe('flow theme tokens', () => {
  it('defines every node accent in both light and dark themes', () => {
    expect(NODE_ACCENT_KEYS.length).toBeGreaterThan(0)
    for (const key of NODE_ACCENT_KEYS) {
      for (const block of [lightTheme, darkTheme]) {
        expect(block).toContain(`--node-${key}:`)
        expect(block).toContain(`--node-${key}-soft:`)
        expect(block).toContain(`--node-${key}-fg:`)
      }
    }
  })

  it('maps every accent key to a node selector', () => {
    for (const key of NODE_ACCENT_KEYS) {
      expect(css).toContain(`.flow-node[data-accent='${key}']`)
    }
  })

  it('defines a dedicated high-contrast wire token in both themes', () => {
    function tokenValue(block: string, name: string): string | undefined {
      return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim()
    }
    for (const block of [lightTheme, darkTheme]) {
      const wire = tokenValue(block, '--flow-wire')
      const border = tokenValue(block, '--border-strong')
      expect(wire).toBeDefined()
      expect(border).toBeDefined()
      // A hairline divider colour is not a readable connection colour.
      expect(wire).not.toBe(border)
    }
  })
})
