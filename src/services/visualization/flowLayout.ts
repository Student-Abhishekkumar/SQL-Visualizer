/**
 * Incremental flow-canvas layout.
 *
 * The graph builder produces a deterministic first layout. After a user
 * drags a node, this module nudges only the nodes that the drag actually
 * disturbed: the dragged node stays exactly where it was dropped, its
 * neighbours move just enough to restore the minimum spacing, and any
 * resulting collision is resolved in turn. Unrelated nodes are never
 * touched, so the graph settles instead of fighting the user's position.
 *
 * The solver is deliberately small and dependency-free. It works on
 * rectangles (real widths/heights, including an expanded preview's
 * height), supports positions on either side of the graph origin, and is
 * fully deterministic for identical input.
 */

export interface FlowLayoutBox {
  id: string
  x: number
  y: number
  width: number
  height: number
  /**
   * The node's original pipeline column (the builder's `node.x`). Nodes
   * from the same column move vertically, preserving the top-to-bottom
   * pipeline spine instead of being shoved sideways.
   */
  column: number
  /** True when the user has intentionally positioned this node before. */
  manual?: boolean
}

export interface FlowLayoutOptions {
  /** Node under the pointer when the drag ended; it never moves. */
  pinnedId: string
  gapX?: number
  gapY?: number
  maxPasses?: number
}

export const FLOW_LAYOUT_GAP_X = 24
export const FLOW_LAYOUT_GAP_Y = 12

/** Canvas breathing room after the outermost node. */
const BOUNDS_PADDING = 48
/** Padding after the main pipeline for the width-fit camera. */
const FLOW_WIDTH_PADDING = 28

/**
 * Rectangles overlap when they are closer than the required clearance on
 * *both* axes. Touching at exactly `gap` pixels is allowed.
 */
export function flowBoxesOverlap(
  a: Pick<FlowLayoutBox, 'x' | 'y' | 'width' | 'height'>,
  b: Pick<FlowLayoutBox, 'x' | 'y' | 'width' | 'height'>,
  gapX: number = FLOW_LAYOUT_GAP_X,
  gapY: number = FLOW_LAYOUT_GAP_Y,
): boolean {
  return (
    a.x < b.x + b.width + gapX &&
    a.x + a.width + gapX > b.x &&
    a.y < b.y + b.height + gapY &&
    a.y + a.height + gapY > b.y
  )
}

interface AxisCandidate {
  axis: 'x' | 'y'
  delta: number
  preferred: boolean
  horizontal: boolean
}

/**
 * Compute the smallest move for `mover` that clears `other`. Preferred
 * directions point away from the other node; the opposite direction is
 * considered when it clears the overlap for a lower cost. Moving along
 * the node's own column is always preferred over sideways moves.
 */
function separateBoxes(
  mover: FlowLayoutBox,
  moverPos: { x: number; y: number },
  other: FlowLayoutBox,
  otherPos: { x: number; y: number },
  gapX: number,
  gapY: number,
): { x: number; y: number } {
  const sameColumn = Math.abs(mover.column - other.column) < 0.5
  const moverCenterX = moverPos.x + mover.width / 2
  const moverCenterY = moverPos.y + mover.height / 2
  const otherCenterX = otherPos.x + other.width / 2
  const otherCenterY = otherPos.y + other.height / 2

  // Target positions that place the mover fully before/after the other
  // node on each axis, including the required clearance.
  const down = otherPos.y + other.height + gapY - moverPos.y
  const up = moverPos.y + mover.height + gapY - otherPos.y
  const right = otherPos.x + other.width + gapX - moverPos.x
  const left = moverPos.x + mover.width + gapX - otherPos.x

  const candidates: AxisCandidate[] = [
    { axis: 'y', delta: down, preferred: moverCenterY >= otherCenterY, horizontal: false },
    { axis: 'y', delta: -up, preferred: moverCenterY < otherCenterY, horizontal: false },
  ]
  if (!sameColumn) {
    candidates.push(
      { axis: 'x', delta: right, preferred: moverCenterX >= otherCenterX, horizontal: true },
      { axis: 'x', delta: -left, preferred: moverCenterX < otherCenterX, horizontal: true },
    )
  }

  let best: { x: number; y: number; cost: number; clears: boolean } | null = null
  for (const candidate of candidates) {
    const x = candidate.axis === 'x' ? moverPos.x + candidate.delta : moverPos.x
    const y = candidate.axis === 'y' ? moverPos.y + candidate.delta : moverPos.y
    const clears = !flowBoxesOverlap(
      { x, y, width: mover.width, height: mover.height },
      { ...otherPos, width: other.width, height: other.height },
      gapX,
      gapY,
    )
    // Distance actually travelled. Sideways moves get a small penalty so
    // the vertical pipeline stays the default.
    const distance = Math.hypot(x - moverPos.x, y - moverPos.y)
    const cost = distance * (candidate.horizontal ? 1.15 : 1) * (candidate.preferred ? 1 : 1.2)
    if (best === null || (clears && !best.clears) || (clears === best.clears && cost < best.cost)) {
      best = { x, y, cost, clears }
    }
  }

  return best === null ? { x: moverPos.x, y: moverPos.y } : { x: best.x, y: best.y }
}

function chooseMover(
  a: FlowLayoutBox,
  b: FlowLayoutBox,
  pinnedId: string,
  dirty: ReadonlySet<string>,
): FlowLayoutBox {
  if (a.id === pinnedId) return b
  if (b.id === pinnedId) return a
  const aDirty = dirty.has(a.id)
  const bDirty = dirty.has(b.id)
  // Only the node that was dragged into the collision should push its
  // neighbour; the neighbour should not push back.
  if (aDirty && !bDirty) return b
  if (bDirty && !aDirty) return a
  // Both are affected: preserve an intentionally placed node first.
  if (a.manual !== b.manual) return a.manual ? b : a
  return a.id < b.id ? b : a
}

/**
 * Resolve the collisions caused by dropping one node.
 *
 * Returns a position for every box (unchanged boxes keep their input
 * coordinates). The pinned node is never moved.
 */
export function resolveFlowLayout(
  boxes: readonly FlowLayoutBox[],
  options: FlowLayoutOptions,
): Map<string, { x: number; y: number }> {
  const gapX = options.gapX ?? FLOW_LAYOUT_GAP_X
  const gapY = options.gapY ?? FLOW_LAYOUT_GAP_Y
  const maxPasses = options.maxPasses ?? 24

  const positions = new Map<string, { x: number; y: number }>(
    boxes.map((box) => [box.id, { x: box.x, y: box.y }]),
  )
  if (!boxes.some((box) => box.id === options.pinnedId)) return positions

  // Start from the dropped node and spread outwards only as collisions
  // demand it. Nodes that are never reached stay exactly where they are.
  const dirty = new Set<string>([options.pinnedId])
  const ordered = [...boxes].sort((a, b) => a.id.localeCompare(b.id))

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false
    for (let i = 0; i < ordered.length; i += 1) {
      const a = ordered[i]
      if (a === undefined) continue
      for (let j = i + 1; j < ordered.length; j += 1) {
        const b = ordered[j]
        if (b === undefined) continue
        if (!dirty.has(a.id) && !dirty.has(b.id)) continue
        const aPos = positions.get(a.id)
        const bPos = positions.get(b.id)
        if (aPos === undefined || bPos === undefined) continue
        if (
          !flowBoxesOverlap(
            { ...aPos, width: a.width, height: a.height },
            { ...bPos, width: b.width, height: b.height },
            gapX,
            gapY,
          )
        ) {
          continue
        }
        const mover = chooseMover(a, b, options.pinnedId, dirty)
        const other = mover.id === a.id ? b : a
        const moverPos = positions.get(mover.id)
        const otherPos = positions.get(other.id)
        if (moverPos === undefined || otherPos === undefined) continue
        positions.set(
          mover.id,
          separateBoxes(mover, moverPos, other, otherPos, gapX, gapY),
        )
        dirty.add(mover.id)
        dirty.add(other.id)
        moved = true
      }
    }
    if (!moved) break
  }

  return positions
}

export interface FlowFitBounds {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** True bounds of every visible node rectangle, on either side of the origin. */
export function measureFlowFitBounds(
  boxes: readonly FlowLayoutExtentBox[],
): FlowFitBounds | null {
  if (boxes.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const box of boxes) {
    left = Math.min(left, box.x)
    top = Math.min(top, box.y)
    right = Math.max(right, box.x + box.width)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

export interface FlowFitViewport {
  width: number
  height: number
  padding: number
  minZoom: number
  maxZoom: number
  /**
   * Extra room around the outermost node rectangles for sockets, socket
   * labels and arrowheads that sit outside the node box. Symmetric, so it
   * never changes the graph centre or the final node's visibility.
   */
  clearance?: number
}

/** Extra room the camera keeps around the outermost node boxes. */
export const FLOW_FIT_CLEARANCE = 36

/**
 * Readable-overview floor for the first camera on a new graph. When the
 * whole graph fits at or above this zoom the initial view shows all of it;
 * long pipelines fall back to a top-anchored width fit instead of shrinking
 * labels into illegibility.
 */
export const INITIAL_FIT_MIN_ZOOM = 0.5

/** Top inset for the width-fit camera, in screen pixels. */
const WIDTH_FIT_TOP = 16

/** Fit and centre complete node bounds without modifying any node position. */
export function fitFlowLayout(
  boxes: readonly FlowLayoutExtentBox[],
  viewport: FlowFitViewport,
): { zoom: number; panX: number; panY: number } | null {
  const bounds = measureFlowFitBounds(boxes)
  if (bounds === null) return null
  const clearance = viewport.clearance ?? 0
  const contentWidth = bounds.width + clearance * 2
  const contentHeight = bounds.height + clearance * 2
  const left = bounds.left - clearance
  const top = bounds.top - clearance
  const availableWidth = Math.max(1, viewport.width - viewport.padding * 2)
  const availableHeight = Math.max(1, viewport.height - viewport.padding * 2)
  const scale = Math.min(
    availableWidth / Math.max(contentWidth, 1),
    availableHeight / Math.max(contentHeight, 1),
  )
  const zoom = Math.min(viewport.maxZoom, Math.max(viewport.minZoom, scale))
  return {
    zoom,
    panX: (viewport.width - contentWidth * zoom) / 2 - left * zoom,
    panY: (viewport.height - contentHeight * zoom) / 2 - top * zoom,
  }
}

/**
 * Width-fit camera anchored at the top of the graph.
 *
 * It measures **every** node box, including branch and group nodes in the
 * side column, so a graph is never clipped horizontally at 100% just
 * because its main spine is narrower than the canvas.
 */
export function fitFlowLayoutWidth(
  boxes: readonly FlowLayoutExtentBox[],
  viewport: FlowFitViewport,
): { zoom: number; panX: number; panY: number } | null {
  const bounds = measureFlowFitBounds(boxes)
  if (bounds === null) return null
  const clearance = viewport.clearance ?? 0
  const left = bounds.left - clearance
  const contentWidth = bounds.width + clearance * 2
  const availableWidth = Math.max(1, viewport.width - viewport.padding * 2)
  const scale = availableWidth / Math.max(contentWidth, 1)
  const zoom = Math.min(viewport.maxZoom, Math.max(viewport.minZoom, Math.min(scale, 1)))
  return {
    zoom,
    panX: (viewport.width - contentWidth * zoom) / 2 - left * zoom,
    panY: WIDTH_FIT_TOP - (bounds.top - clearance) * zoom,
  }
}

/**
 * Camera for a freshly visualized graph.
 *
 * A graph that fits the viewport at a readable zoom opens fully visible,
 * including its final node. A very long pipeline opens width-fitted and
 * top-anchored, which keeps labels readable; panning and the playback
 * controls then move through it.
 */
export function initialFlowLayout(
  boxes: readonly FlowLayoutExtentBox[],
  viewport: FlowFitViewport,
): { zoom: number; panX: number; panY: number } | null {
  const readable = fitFlowLayout(boxes, {
    ...viewport,
    maxZoom: Math.min(viewport.maxZoom, 1),
  })
  if (readable !== null && readable.zoom >= INITIAL_FIT_MIN_ZOOM) return readable
  return fitFlowLayoutWidth(boxes, viewport)
}

export interface FlowLayoutExtentBox {
  x: number
  y: number
  width: number
  height: number
  /** Branch/group nodes live in side columns, outside the main flow width. */
  side?: boolean
}

export interface FlowLayoutBounds {
  width: number
  height: number
  flowWidth: number
}

/**
 * Recalculate the canvas surface from the live node placements. `minimum`
 * is the builder's deterministic bound, so the surface never shrinks
 * below the designed layout when nodes are dragged inward.
 */
export function measureFlowLayout(
  boxes: readonly FlowLayoutExtentBox[],
  minimum?: FlowLayoutBounds,
): FlowLayoutBounds {
  let width = minimum?.width ?? 0
  let height = minimum?.height ?? 0
  let flowWidth = minimum?.flowWidth ?? 0
  for (const box of boxes) {
    width = Math.max(width, box.x + box.width + BOUNDS_PADDING)
    height = Math.max(height, box.y + box.height + BOUNDS_PADDING)
    // Every real node contributes to the content width, including branch and
    // group cards in the side column. A width that ignored them let earlier
    // camera code measure the graph too narrowly and clip those cards.
    flowWidth = Math.max(flowWidth, box.x + box.width + FLOW_WIDTH_PADDING)
  }
  return {
    width,
    height,
    flowWidth: Math.min(width, flowWidth),
  }
}
