import { describe, expect, it } from 'vitest'
import {
  clampPosition,
  clampRect,
  defaultRect,
  maximizeRect,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  moveRect,
  rectNearAnchor,
  resizeRect,
  RESIZE_EDGES,
  windowHeightLimits,
  windowWidthLimits,
  type ResizeEdge,
  type WindowBounds,
  type WindowRect,
} from './floatingWindow'

const bounds: WindowBounds = { width: 1000, height: 800 }
const base: WindowRect = { x: 100, y: 100, width: 500, height: 400 }

describe('floatingWindow geometry', () => {
  it('sizes the default window from the workspace and keeps it on screen', () => {
    const rect = defaultRect(bounds)
    expect(rect.width).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
    expect(rect.height).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.height)
  })

  it('uses the minimum size and origin for an unmeasurable workspace', () => {
    const rect = defaultRect({ width: 0, height: 0 })
    expect(rect).toEqual({ x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT })
  })

  it('clamps a rectangle into the bounds on every side', () => {
    expect(clampRect({ x: -50, y: -30, width: 500, height: 400 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: 500,
      height: 400,
    })
    expect(clampRect({ x: 900, y: 700, width: 500, height: 400 }, bounds)).toEqual({
      x: 500,
      y: 400,
      width: 500,
      height: 400,
    })
  })

  it('enforces the minimum and maximum dimensions', () => {
    expect(clampRect({ x: 0, y: 0, width: 100, height: 100 }, bounds)).toMatchObject({
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
    })
    expect(clampRect({ x: 0, y: 0, width: 5000, height: 5000 }, bounds)).toMatchObject({
      width: bounds.width,
      height: bounds.height,
    })
  })

  it('moves without changing size and never leaves the workspace', () => {
    const moved = moveRect(base, 60, 40, bounds)
    expect(moved).toEqual({ x: 160, y: 140, width: 500, height: 400 })
    const clamped = moveRect(base, 9999, 9999, bounds)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(bounds.width)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(bounds.height)
  })

  it('moves a header-height rectangle using its real height, not the minimum', () => {
    const collapsed = { ...base, height: 52 }
    const moved = moveRect(collapsed, 60, 40, bounds)
    expect(moved).toEqual({ x: 160, y: 140, width: 500, height: 52 })
    const clamped = moveRect(collapsed, 9999, 9999, bounds)
    expect(clamped).toEqual({ x: 500, y: 748, width: 500, height: 52 })
  })

  it('clamps position without forcing the minimum window size', () => {
    expect(clampPosition({ x: -50, y: 900, width: 500, height: 52 }, bounds)).toEqual({
      x: 0,
      y: 748,
      width: 500,
      height: 52,
    })
  })

  it('resizes from every edge, anchoring the opposite edge', () => {
    const east = resizeRect(base, 'e', 80, 0, bounds)
    expect(east).toEqual({ x: 100, y: 100, width: 580, height: 400 })
    const south = resizeRect(base, 's', 0, 50, bounds)
    expect(south).toEqual({ x: 100, y: 100, width: 500, height: 450 })
    const west = resizeRect(base, 'w', -40, 0, bounds)
    expect(west).toEqual({ x: 60, y: 100, width: 540, height: 400 })
    const north = resizeRect(base, 'n', 0, -30, bounds)
    expect(north).toEqual({ x: 100, y: 70, width: 500, height: 430 })
  })

  it('resizes from every corner', () => {
    expect(resizeRect(base, 'se', 50, 50, bounds)).toEqual({
      x: 100,
      y: 100,
      width: 550,
      height: 450,
    })
    expect(resizeRect(base, 'ne', 50, -30, bounds)).toEqual({
      x: 100,
      y: 70,
      width: 550,
      height: 430,
    })
    expect(resizeRect(base, 'sw', -30, 40, bounds)).toEqual({
      x: 70,
      y: 100,
      width: 530,
      height: 440,
    })
    expect(resizeRect(base, 'nw', -30, -20, bounds)).toEqual({
      x: 70,
      y: 80,
      width: 530,
      height: 420,
    })
  })

  it('never resizes below the minimum on any edge', () => {
    for (const edge of RESIZE_EDGES) {
      const shrunk = resizeRect(base, edge, 9999, 9999, bounds)
      expect(shrunk.width, edge).toBeGreaterThanOrEqual(MIN_WINDOW_WIDTH)
      expect(shrunk.height, edge).toBeGreaterThanOrEqual(MIN_WINDOW_HEIGHT)
      expect(shrunk.x, edge).toBeGreaterThanOrEqual(0)
      expect(shrunk.y, edge).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps a resized window inside the workspace near every boundary', () => {
    const corners: Array<{ edge: ResizeEdge; rect: WindowRect }> = [
      { edge: 'nw', rect: { x: 0, y: 0, width: 500, height: 400 } },
      { edge: 'ne', rect: { x: 500, y: 0, width: 500, height: 400 } },
      { edge: 'sw', rect: { x: 0, y: 400, width: 500, height: 400 } },
      { edge: 'se', rect: { x: 500, y: 400, width: 500, height: 400 } },
    ]
    for (const { edge, rect } of corners) {
      const grown = resizeRect(rect, edge, 400, 400, bounds)
      expect(grown.x + grown.width, edge).toBeLessThanOrEqual(bounds.width)
      expect(grown.y + grown.height, edge).toBeLessThanOrEqual(bounds.height)
    }
  })

  it('caps the size at a boundary instead of sliding the anchored edge', () => {
    const east = resizeRect({ x: 600, y: 100, width: 380, height: 300 }, 'e', 400, 0, bounds)
    expect(east.x).toBe(600)
    expect(east.x + east.width).toBe(bounds.width)

    const south = resizeRect({ x: 600, y: 100, width: 380, height: 300 }, 's', 0, 900, bounds)
    expect(south.y).toBe(100)
    expect(south.y + south.height).toBe(bounds.height)

    const north = resizeRect({ x: 100, y: 400, width: 400, height: 300 }, 'n', 0, -400, bounds)
    expect(north.y + north.height).toBe(700)

    const west = resizeRect({ x: 100, y: 100, width: 400, height: 300 }, 'w', -400, 0, bounds)
    expect(west.x).toBe(0)
    expect(west.x + west.width).toBe(500)
  })

  it('maximizes to the workspace without dropping below the minimum', () => {
    expect(maximizeRect(bounds)).toEqual({ x: 0, y: 0, width: 1000, height: 800 })
    expect(maximizeRect({ width: 10, height: 10 })).toEqual({
      x: 0,
      y: 0,
      width: MIN_WINDOW_WIDTH,
      height: MIN_WINDOW_HEIGHT,
    })
  })

  it('places the window beside the anchor, flipping sides when needed', () => {
    const rect: WindowRect = { x: 0, y: 0, width: 400, height: 300 }
    const right = rectNearAnchor({ x: 100, y: 100, width: 200, height: 60 }, rect, bounds)
    expect(right.x).toBeGreaterThan(300)
    // No room on the right → flip to the left of the anchor.
    const left = rectNearAnchor({ x: 800, y: 100, width: 200, height: 60 }, rect, bounds)
    expect(left.x + left.width).toBeLessThanOrEqual(800)
    // Anchor unknown → clamp the base rectangle.
    expect(rectNearAnchor(null, rect, bounds)).toEqual(rect)
  })

  it('reports the width/height limits it enforces', () => {
    expect(windowWidthLimits(bounds)).toEqual({ min: MIN_WINDOW_WIDTH, max: 1000 })
    expect(windowHeightLimits(bounds)).toEqual({ min: MIN_WINDOW_HEIGHT, max: 800 })
  })
})
