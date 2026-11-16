/**
 * Floating-window geometry for the Node Inspector popup.
 *
 * Pure, deterministic helpers so drag/resize behaviour is testable
 * without a DOM. Every coordinate is in CSS pixels relative to the
 * positioned overlay container the popup lives in (the canvas layer of
 * the visualization workspace).
 *
 * The geometry keeps three invariants that the UI relies on:
 *  - the window never opens or ends up outside the visible workspace,
 *  - it never shrinks below the readable minimum, and
 *  - it never grows past the workspace (so it can always be scrolled or
 *    seen in full).
 */

export interface WindowRect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowBounds {
  width: number
  height: number
}

/** Minimum readable window size (requirement: ~380 × ~280). */
export const MIN_WINDOW_WIDTH = 380
export const MIN_WINDOW_HEIGHT = 280

/** Default share of the workspace used the first time the popup opens. */
const DEFAULT_WIDTH_RATIO = 0.46
const DEFAULT_HEIGHT_RATIO = 0.72
/** Gap from the workspace edge, and from an anchor node. */
const EDGE_MARGIN = 16
const ANCHOR_GAP = 12

export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** All eight resize handles, in a stable order. */
export const RESIZE_EDGES: readonly ResizeEdge[] = [
  'n',
  's',
  'e',
  'w',
  'ne',
  'nw',
  'se',
  'sw',
]

/** Pointer cursor for each resize handle. */
export const RESIZE_CURSORS: Record<ResizeEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Width limits. The minimum is always the readable minimum: a workspace
 * narrower than that still gets a minimum-size window anchored at the
 * origin rather than a cramped one.
 */
export function windowWidthLimits(bounds: WindowBounds): { min: number; max: number } {
  const min = MIN_WINDOW_WIDTH
  return { min, max: Math.max(min, Math.round(bounds.width)) }
}

/** Height limits, mirroring {@link windowWidthLimits}. */
export function windowHeightLimits(bounds: WindowBounds): { min: number; max: number } {
  const min = MIN_WINDOW_HEIGHT
  return { min, max: Math.max(min, Math.round(bounds.height)) }
}

/** Clamp a rectangle to the size limits and keep it fully inside the bounds. */
export function clampRect(rect: WindowRect, bounds: WindowBounds): WindowRect {
  const widthLimits = windowWidthLimits(bounds)
  const heightLimits = windowHeightLimits(bounds)
  const width = clamp(rect.width, widthLimits.min, widthLimits.max)
  const height = clamp(rect.height, heightLimits.min, heightLimits.max)
  const x = clamp(rect.x, 0, Math.max(0, bounds.width - width))
  const y = clamp(rect.y, 0, Math.max(0, bounds.height - height))
  return { x, y, width, height }
}

/** A sensible first-open rectangle for the available workspace. */
export function defaultRect(bounds: WindowBounds): WindowRect {
  const { min: minW, max: maxW } = windowWidthLimits(bounds)
  const { min: minH, max: maxH } = windowHeightLimits(bounds)
  const width = clamp(Math.round(bounds.width * DEFAULT_WIDTH_RATIO), minW, maxW)
  const height = clamp(Math.round(bounds.height * DEFAULT_HEIGHT_RATIO), minH, maxH)
  return clampRect(
    { x: bounds.width - width - EDGE_MARGIN, y: EDGE_MARGIN, width, height },
    bounds,
  )
}

/** Move a rectangle by a delta, keeping it inside the bounds. */
export function moveRect(
  start: WindowRect,
  dx: number,
  dy: number,
  bounds: WindowBounds,
): WindowRect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds)
}

/**
 * Apply an edge/corner resize. The non-moving edge stays fixed, so a
 * west/north drag grows the window toward the pointer.
 */
export function resizeRect(
  start: WindowRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  bounds: WindowBounds,
): WindowRect {
  const left = edge.includes('w') ? start.x + dx : start.x
  const right = edge.includes('e') ? start.x + start.width + dx : start.x + start.width
  const top = edge.includes('n') ? start.y + dy : start.y
  const bottom = edge.includes('s') ? start.y + start.height + dy : start.y + start.height

  const { min: minW, max: maxW } = windowWidthLimits(bounds)
  const { min: minH, max: maxH } = windowHeightLimits(bounds)
  // The growing dimension is capped by the space measured from the anchored
  // edge, so pushing a handle past a workspace boundary caps the size
  // instead of sliding the window away from the cursor.
  const widthCap = edge.includes('e')
    ? bounds.width - start.x
    : edge.includes('w')
      ? start.x + start.width
      : maxW
  const heightCap = edge.includes('s')
    ? bounds.height - start.y
    : edge.includes('n')
      ? start.y + start.height
      : maxH
  const width = clamp(right - left, minW, Math.max(minW, Math.min(maxW, widthCap)))
  const height = clamp(bottom - top, minH, Math.max(minH, Math.min(maxH, heightCap)))

  const x = edge.includes('w') ? right - width : left
  const y = edge.includes('n') ? bottom - height : top
  return clampRect({ x, y, width, height }, bounds)
}

/** The maximized rectangle (the whole workspace, never below the minimum). */
export function maximizeRect(bounds: WindowBounds): WindowRect {
  const { min: minW } = windowWidthLimits(bounds)
  const { min: minH } = windowHeightLimits(bounds)
  return {
    x: 0,
    y: 0,
    width: Math.max(minW, Math.round(bounds.width)),
    height: Math.max(minH, Math.round(bounds.height)),
  }
}

/**
 * Place a rectangle next to an anchor (the selected node's on-screen
 * box), preferring the right side, then the left, then below — always
 * clamped back into the workspace.
 */
export function rectNearAnchor(
  anchor: { x: number; y: number; width: number; height: number } | null,
  rect: WindowRect,
  bounds: WindowBounds,
): WindowRect {
  if (anchor === null || anchor.width <= 0 || anchor.height <= 0) {
    return clampRect(rect, bounds)
  }
  if (anchor.x + anchor.width + ANCHOR_GAP + rect.width <= bounds.width) {
    return clampRect({ ...rect, x: anchor.x + anchor.width + ANCHOR_GAP, y: anchor.y }, bounds)
  }
  if (anchor.x - ANCHOR_GAP - rect.width >= 0) {
    return clampRect({ ...rect, x: anchor.x - ANCHOR_GAP - rect.width, y: anchor.y }, bounds)
  }
  return clampRect(
    { ...rect, x: anchor.x, y: anchor.y + anchor.height + ANCHOR_GAP },
    bounds,
  )
}
