/**
 * Cinematic loading canvas — composition model.
 *
 * The application loader is a large-scale, living version of the real
 * data-flow Canvas: the same operation accents (`--node-*`), the same
 * node-card anatomy (rail, tinted header, badge, meta, column chips,
 * preview rows, status orb, sockets) and the same curved, arrow-marked
 * wires. Geometry lives here so it is deterministic and testable, while
 * the component only renders and CSS only animates.
 */

export type LoaderAccent =
  | 'source'
  | 'join'
  | 'where'
  | 'group'
  | 'having'
  | 'select'
  | 'final'
  | 'rejected'

export type LoaderKind = 'source' | 'operation' | 'group' | 'final' | 'branch'
export type LoaderMode = 'desktop' | 'portrait' | 'short'
export type SocketSide = 'left' | 'right' | 'top' | 'bottom'

export interface LoaderNode {
  id: string
  title: string
  accent: LoaderAccent
  kind: LoaderKind
  badge?: string
  meta?: string
  chips?: string[]
  preview?: string[][]
  /** Seconds after mount before the node emerges. */
  delay: number
  /** Seconds after mount before its status orb completes. */
  doneDelay: number
  dashed?: boolean
  focal?: boolean
  x: number
  y: number
  w: number
  h: number
}

export interface LoaderEdge {
  id: string
  from: string
  to: string
  accent: LoaderAccent
  label?: string
  dashed?: boolean
  /** Seconds after mount before the wire draws. */
  delay: number
  /** Draw duration in seconds. */
  duration: number
}

export interface EdgeGeometry {
  d: string
  arrow: { x: number; y: number; angle: number }
  label?: { x: number; y: number; width: number }
}

export interface LoaderGraph {
  mode: LoaderMode
  width: number
  height: number
  nodes: LoaderNode[]
  edges: LoaderEdge[]
  sockets: Record<string, SocketSide[]>
  geometry: Record<string, EdgeGeometry>
}

type Box = Pick<LoaderNode, 'x' | 'y' | 'w' | 'h'>

interface NodeContent {
  title: string
  accent: LoaderAccent
  kind: LoaderKind
  badge?: string
  meta?: string
  chips?: string[]
  preview?: string[][]
  delay: number
  doneDelay: number
  dashed?: boolean
  focal?: boolean
}

const CONTENT: Record<string, NodeContent> = {
  employees: {
    title: 'employees',
    accent: 'source',
    kind: 'source',
    badge: 'FROM',
    meta: '1,284 rows · 6 cols',
    chips: ['id', 'name', 'dept_id', 'salary'],
    preview: [
      ['1', 'Ava', '3', '88k'],
      ['2', 'Liam', '1', '72k'],
      ['3', 'Noah', '2', '64k'],
    ],
    delay: 0.35,
    doneDelay: 1,
  },
  departments: {
    title: 'departments',
    accent: 'source',
    kind: 'source',
    badge: 'JOIN',
    meta: '8 rows · 3 cols',
    chips: ['id', 'name', 'budget'],
    delay: 0.55,
    doneDelay: 1.2,
  },
  where: {
    title: 'WHERE',
    accent: 'where',
    kind: 'operation',
    badge: 'salary > 60k',
    meta: '1,284 → 902 rows',
    delay: 0.8,
    doneDelay: 1.45,
  },
  join: {
    title: 'INNER JOIN',
    accent: 'join',
    kind: 'operation',
    badge: 'dept_id',
    meta: '902 → 1,106 rows',
    delay: 1.15,
    doneDelay: 1.8,
  },
  group: {
    title: 'GROUP BY',
    accent: 'group',
    kind: 'group',
    badge: 'department',
    meta: 'grouped into 8 buckets',
    delay: 1.5,
    doneDelay: 2.1,
  },
  rejected: {
    title: 'rejected',
    accent: 'rejected',
    kind: 'branch',
    badge: 'removed',
    meta: '382 rows',
    delay: 1.65,
    doneDelay: 2.3,
    dashed: true,
  },
  having: {
    title: 'HAVING',
    accent: 'having',
    kind: 'operation',
    badge: 'count > 120',
    meta: '8 → 5 groups',
    delay: 1.85,
    doneDelay: 2.45,
  },
  final: {
    title: 'Final result',
    accent: 'final',
    kind: 'final',
    badge: 'OUTPUT',
    meta: '231 rows · 3 cols',
    chips: ['department', 'headcount', 'avg_salary'],
    preview: [
      ['Engineering', '42', '96k'],
      ['Design', '18', '81k'],
      ['Sales', '31', '74k'],
    ],
    delay: 2.2,
    doneDelay: 2.85,
    focal: true,
  },
}

const DESKTOP_BOXES: Record<string, Box> = {
  employees: { x: 30, y: 370, w: 250, h: 190 },
  departments: { x: 345, y: 70, w: 230, h: 140 },
  where: { x: 345, y: 430, w: 230, h: 140 },
  join: { x: 650, y: 250, w: 250, h: 150 },
  rejected: { x: 345, y: 740, w: 230, h: 130 },
  group: { x: 960, y: 430, w: 250, h: 150 },
  having: { x: 960, y: 740, w: 230, h: 140 },
  final: { x: 1250, y: 360, w: 290, h: 210 },
}

const PORTRAIT_BOXES: Record<string, Box> = {
  employees: { x: 40, y: 40, w: 400, h: 190 },
  where: { x: 460, y: 230, w: 400, h: 150 },
  join: { x: 40, y: 420, w: 400, h: 150 },
  group: { x: 460, y: 610, w: 400, h: 150 },
  having: { x: 40, y: 800, w: 400, h: 150 },
  final: { x: 250, y: 980, w: 400, h: 190 },
}

const SHORT_BOXES: Record<string, Box> = {
  employees: { x: 30, y: 15, w: 370, h: 190 },
  where: { x: 30, y: 215, w: 370, h: 150 },
  group: { x: 30, y: 375, w: 370, h: 150 },
  final: { x: 30, y: 535, w: 370, h: 190 },
}

const DESKTOP_EDGES: LoaderEdge[] = [
  { id: 'employees-where', from: 'employees', to: 'where', accent: 'where', delay: 1, duration: 0.8 },
  { id: 'departments-join', from: 'departments', to: 'join', accent: 'join', delay: 1.25, duration: 0.9 },
  { id: 'where-join', from: 'where', to: 'join', accent: 'join', delay: 1.3, duration: 0.9 },
  { id: 'join-group', from: 'join', to: 'group', accent: 'group', delay: 1.65, duration: 0.9, label: 'dept_id' },
  { id: 'group-having', from: 'group', to: 'having', accent: 'having', delay: 1.8, duration: 0.7 },
  { id: 'where-rejected', from: 'where', to: 'rejected', accent: 'rejected', delay: 1.9, duration: 0.7, dashed: true, label: 'removed' },
  { id: 'group-final', from: 'group', to: 'final', accent: 'final', delay: 1.95, duration: 0.9 },
  { id: 'having-final', from: 'having', to: 'final', accent: 'final', delay: 2.15, duration: 1, label: 'count > 120' },
]

const PORTRAIT_EDGES: LoaderEdge[] = [
  { id: 'employees-where', from: 'employees', to: 'where', accent: 'where', delay: 1, duration: 0.6 },
  { id: 'where-join', from: 'where', to: 'join', accent: 'join', delay: 1.3, duration: 0.6 },
  { id: 'join-group', from: 'join', to: 'group', accent: 'group', delay: 1.65, duration: 0.6 },
  { id: 'group-having', from: 'group', to: 'having', accent: 'having', delay: 1.95, duration: 0.6 },
  { id: 'having-final', from: 'having', to: 'final', accent: 'final', delay: 2.25, duration: 0.7 },
]

const SHORT_EDGES: LoaderEdge[] = [
  { id: 'employees-where', from: 'employees', to: 'where', accent: 'where', delay: 1, duration: 0.6 },
  { id: 'where-group', from: 'where', to: 'group', accent: 'group', delay: 1.5, duration: 0.6 },
  { id: 'group-final', from: 'group', to: 'final', accent: 'final', delay: 2, duration: 0.7 },
]

type Side = SocketSide

function anchor(node: Box, side: Side) {
  switch (side) {
    case 'left':
      return { x: node.x, y: node.y + node.h / 2 }
    case 'right':
      return { x: node.x + node.w, y: node.y + node.h / 2 }
    case 'top':
      return { x: node.x + node.w / 2, y: node.y }
    case 'bottom':
      return { x: node.x + node.w / 2, y: node.y + node.h }
  }
}

function controlPoint(node: Box, side: Side, distance: number) {
  const point = anchor(node, side)
  switch (side) {
    case 'left':
      return { x: point.x - distance, y: point.y }
    case 'right':
      return { x: point.x + distance, y: point.y }
    case 'top':
      return { x: point.x, y: point.y - distance }
    case 'bottom':
      return { x: point.x, y: point.y + distance }
  }
}

/** Cubic Bézier midpoint (t = 0.5). */
function midpoint(
  sx: number,
  sy: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  tx: number,
  ty: number,
) {
  return {
    x: (sx + 3 * c1x + 3 * c2x + tx) / 8,
    y: (sy + 3 * c1y + 3 * c2y + ty) / 8,
  }
}

/** Derives which sides two nodes connect on from their relative positions. */
function sidesFor(from: Box, to: Box): { source: Side; target: Side } {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2)
  const dy = to.y + to.h / 2 - (from.y + from.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { source: 'right', target: 'left' } : { source: 'left', target: 'right' }
  }
  return dy >= 0 ? { source: 'bottom', target: 'top' } : { source: 'top', target: 'bottom' }
}

export function buildEdgeGeometry(from: Box, to: Box): EdgeGeometry {
  const { source, target } = sidesFor(from, to)
  const start = anchor(from, source)
  const end = anchor(to, target)
  const span = Math.hypot(end.x - start.x, end.y - start.y)
  const distance = Math.max(56, Math.min(180, span * 0.42))
  const c1 = controlPoint(from, source, distance)
  const c2 = controlPoint(to, target, distance)
  const mid = midpoint(start.x, start.y, c1.x, c1.y, c2.x, c2.y, end.x, end.y)
  const angle = (Math.atan2(end.y - c2.y, end.x - c2.x) * 180) / Math.PI
  return {
    d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} C${c1.x.toFixed(1)},${c1.y.toFixed(1)} ${c2.x.toFixed(1)},${c2.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`,
    arrow: { x: end.x, y: end.y, angle },
    label: { x: mid.x, y: mid.y, width: 0 },
  }
}

export function pickLoaderMode(width: number, height: number): LoaderMode {
  if (width >= 1000) return 'desktop'
  if (width >= 600 && height >= 620) return 'portrait'
  // Very short screens keep the composition legible with fewer nodes.
  return 'short'
}

function makeNodes(boxes: Record<string, Box>, ids: readonly string[]): LoaderNode[] {
  return ids.map((id) => {
    const content = CONTENT[id]
    const box = boxes[id]
    if (!content || !box) throw new Error(`Missing loader node ${id}`)
    return { id, ...content, ...box }
  })
}

export function buildGraph(mode: LoaderMode): LoaderGraph {
  const config =
    mode === 'desktop'
      ? { width: 1560, height: 960, boxes: DESKTOP_BOXES, ids: Object.keys(DESKTOP_BOXES), edges: DESKTOP_EDGES }
      : mode === 'portrait'
        ? { width: 900, height: 1180, boxes: PORTRAIT_BOXES, ids: Object.keys(PORTRAIT_BOXES), edges: PORTRAIT_EDGES }
        : { width: 430, height: 760, boxes: SHORT_BOXES, ids: Object.keys(SHORT_BOXES), edges: SHORT_EDGES }

  const nodes = makeNodes(config.boxes, config.ids)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const sockets: Record<string, SocketSide[]> = {}
  for (const node of nodes) sockets[node.id] = []

  const geometry: Record<string, EdgeGeometry> = {}
  for (const edge of config.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const { source, target } = sidesFor(from, to)
    const fromSockets = sockets[edge.from]
    const toSockets = sockets[edge.to]
    if (fromSockets && !fromSockets.includes(source)) fromSockets.push(source)
    if (toSockets && !toSockets.includes(target)) toSockets.push(target)
    const built = buildEdgeGeometry(from, to)
    if (edge.label !== undefined) {
      built.label = { ...built.label!, width: edge.label.length * 5.6 + 14 }
    }
    geometry[edge.id] = built
  }

  return {
    mode,
    width: config.width,
    height: config.height,
    nodes,
    edges: config.edges,
    sockets,
    geometry,
  }
}