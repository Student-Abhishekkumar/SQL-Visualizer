/**
 * Deterministic flow-canvas geometry.
 *
 * Nodes expose sockets as offsets from their top-left corner, and edges
 * carry cubic Bézier control points. Keeping the maths here (instead of
 * measuring the DOM) means wires always meet socket centres exactly,
 * even before React paints, and can be re-routed when a preview expands.
 */

import type { FlowGraphNode, FlowSocket } from '../../types/flowGraph'

export interface FlowPoint {
  x: number
  y: number
}

/** Height used to render a node right now (expanded previews grow). */
export function nodeDisplayHeight(node: FlowGraphNode, expanded: boolean): number {
  return expanded && node.expandedHeight !== undefined ? node.expandedHeight : node.height
}

/**
 * Socket centre relative to the node's top-left corner. Top/bottom ports
 * follow the live render height so they stay on the border while an
 * expanded node grows; lateral ports stay at their deterministic y.
 */
export function socketOffset(
  node: Pick<FlowGraphNode, 'width' | 'height'>,
  socket: FlowSocket,
  height: number = node.height,
): FlowPoint {
  switch (socket.side) {
    case 'top':
      return { x: socket.x, y: 0 }
    case 'bottom':
      return { x: socket.x, y: height }
    case 'left':
      return { x: 0, y: socket.y }
    case 'right':
      return { x: node.width, y: socket.y }
  }
}

/** Socket centre in graph coordinates. */
export function socketPoint(
  node: FlowGraphNode,
  socket: FlowSocket,
  height: number = node.height,
): FlowPoint {
  const offset = socketOffset(node, socket, height)
  return { x: node.x + offset.x, y: node.y + offset.y }
}

/**
 * Where a node actually sits while it is rendered. Expansion both grows a
 * node and pushes the nodes below it down, so routing must use this live
 * placement rather than the builder's static coordinates.
 */
export interface FlowPlacement {
  y: number
  height: number
}

function placementPoint(
  node: FlowGraphNode,
  socket: FlowSocket,
  placement?: FlowPlacement,
): FlowPoint {
  const offset = socketOffset(node, socket, placement?.height ?? node.height)
  return { x: node.x + offset.x, y: (placement?.y ?? node.y) + offset.y }
}

/**
 * Route a wire between two sockets as a cubic Bézier. Horizontal
 * connections leave/enter with horizontal tangents; spine connections
 * (bottom → top) with vertical tangents. That keeps curves readable and
 * prevents them from cutting through neighbouring nodes.
 */
export function routeEdgeCurve(
  from: FlowGraphNode,
  fromSocketId: string,
  to: FlowGraphNode,
  toSocketId: string,
  placement?: { from?: FlowPlacement; to?: FlowPlacement },
): FlowPoint[] {
  const source = from.sockets.find((socket) => socket.id === fromSocketId)
  const target = to.sockets.find((socket) => socket.id === toSocketId)
  if (source === undefined || target === undefined) return []

  const a = placementPoint(from, source, placement?.from)
  const b = placementPoint(to, target, placement?.to)
  const dx = Math.abs(b.x - a.x)
  const dy = Math.abs(b.y - a.y)
  // Distance-aware handles per direction. Using the horizontal span for
  // lateral wires (and the vertical span for spine wires) prevents a
  // long fan-out from looping back past its own socket.
  const horizontalHandle = Math.max(24, Math.min(140, dx * 0.55))
  const verticalHandle = Math.max(18, Math.min(120, dy * 0.55))
  const sourceHorizontal = source.side === 'right' || source.side === 'left'
  const targetHorizontal = target.side === 'right' || target.side === 'left'
  const sourceXSign = source.side === 'left' ? -1 : 1
  const targetXSign = target.side === 'left' ? -1 : 1

  let c1: FlowPoint
  let c2: FlowPoint
  if (sourceHorizontal && targetHorizontal) {
    c1 = { x: a.x + sourceXSign * horizontalHandle, y: a.y }
    c2 = { x: b.x + targetXSign * horizontalHandle, y: b.y }
  } else if (!sourceHorizontal && !targetHorizontal) {
    const sourceYSign = source.side === 'top' ? -1 : 1
    const targetYSign = target.side === 'top' ? -1 : 1
    c1 = { x: a.x, y: a.y + sourceYSign * verticalHandle }
    c2 = { x: b.x, y: b.y + targetYSign * verticalHandle }
  } else if (sourceHorizontal) {
    // Horizontal out, vertical in (or vice versa): use the matching
    // handle length for each axis.
    const targetYSign = target.side === 'top' ? -1 : 1
    c1 = { x: a.x + sourceXSign * horizontalHandle, y: a.y }
    c2 = { x: b.x, y: b.y + targetYSign * verticalHandle }
  } else {
    const sourceYSign = source.side === 'top' ? -1 : 1
    c1 = { x: a.x, y: a.y + sourceYSign * verticalHandle }
    c2 = { x: b.x + targetXSign * horizontalHandle, y: b.y }
  }

  return [a, c1, c2, b]
}

/** Point on a cubic Bézier at t = 0.5 (used for edge labels). */
export function curveMidpoint(curve: FlowPoint[]): FlowPoint {
  if (curve.length < 4) return curve[0] ?? { x: 0, y: 0 }
  const [p0, p1, p2, p3] = curve
  if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) {
    return { x: 0, y: 0 }
  }
  return {
    x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
    y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
  }
}

/** Cubic Bézier control points → SVG path data. */
export function curvePath(curve: FlowPoint[]): string {
  if (curve.length < 4) return ''
  const [p0, p1, p2, p3] = curve
  if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) return ''
  return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`
}
