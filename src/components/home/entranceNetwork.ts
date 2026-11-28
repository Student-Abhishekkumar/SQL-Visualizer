import type { LoaderAccent } from '../common/canvasLoaderLayout'

/**
 * The living query network — composition model for the website entrance.
 *
 * This is deliberately a separate model from `canvasLoaderLayout` (which
 * drives the application loader): the entrance needs a full-viewport network
 * with three visual layers, a reserved brand band that no card may enter, and
 * travelling data signals. Node cards still use the Canvas card anatomy
 * (.cl-node) so the entrance and the product share one visual language.
 *
 * Everything here is deterministic so the layout can be unit-tested:
 *  - no card or pill may intersect the reserved brand band,
 *  - every edge references existing nodes,
 *  - every box stays inside the virtual canvas.
 */

export type EntranceMode = 'desktop' | 'compact' | 'tablet' | 'phone' | 'landscape'
export type NodeKind = 'primary' | 'secondary' | 'peripheral'
export type EdgeWeight = 'pipeline' | 'bridge' | 'faint'
export type Side = 'left' | 'right' | 'top' | 'bottom'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface EntranceNodeSpec extends Rect {
  id: string
  kind: NodeKind
  accent: LoaderAccent
  title: string
  badge?: string
  meta?: string
  chips?: string[]
  preview?: string[][]
  dashed?: boolean
  focal?: boolean
  icon?: 'table' | 'database' | 'key' | 'rows' | 'bolt'
}

export interface EntranceEdgeSpec {
  id: string
  from: string
  to: string
  accent: LoaderAccent
  weight: EdgeWeight
  fromSide?: Side
  toSide?: Side
  label?: string
  dashed?: boolean
  /** Bow the wire further out; 1 is the default. */
  bulge?: number
  /** Explicit polyline waypoints (used for rail routing on phones). */
  via?: Array<{ x: number; y: number }>
  signal?: boolean
}

export interface EntranceNode extends EntranceNodeSpec {
  delay: number
  done: number
}

export interface EntranceEdge extends EntranceEdgeSpec {
  d: string
  delay: number
  duration: number
  arrow: { x: number; y: number; angle: number }
  labelPos?: { x: number; y: number; width: number }
}

export interface EntranceSignal {
  id: string
  d: string
  delay: number
  duration: number
  accent: LoaderAccent
}

export interface EntranceNetwork {
  mode: EntranceMode
  width: number
  height: number
  /** Reserved foreground area for the wordmark, in virtual units. */
  brand: Rect
  nodes: EntranceNode[]
  edges: EntranceEdge[]
  signals: EntranceSignal[]
  sockets: Record<string, Side[]>
}

interface ModeSpec {
  width: number
  height: number
  brand: Rect
  nodes: EntranceNodeSpec[]
  edges: EntranceEdgeSpec[]
}

const CARD = {
  employees: {
    kind: 'primary',
    accent: 'source',
    title: 'employees',
    badge: 'FROM',
    meta: '1,284 rows · 6 cols',
    chips: ['id', 'name', 'dept_id'],
    preview: [
      ['1', 'Ava', '88k'],
      ['2', 'Liam', '72k'],
      ['3', 'Noah', '64k'],
    ],
  },
  departments: {
    kind: 'primary',
    accent: 'source',
    title: 'departments',
    badge: 'JOIN',
    meta: '8 rows · 3 cols',
    chips: ['id', 'name', 'budget'],
  },
  where: {
    kind: 'primary',
    accent: 'where',
    title: 'WHERE',
    badge: '> 60k',
    meta: '1,284 → 902 rows',
    chips: ['dept_id', 'salary'],
  },
  join: {
    kind: 'primary',
    accent: 'join',
    title: 'INNER JOIN',
    badge: 'ON',
    meta: '902 → 1,106 rows',
    chips: ['employees × departments'],
  },
  group: {
    kind: 'primary',
    accent: 'group',
    title: 'GROUP BY',
    badge: 'dept',
    meta: '8 buckets',
    chips: ['count(*)', 'avg(salary)'],
  },
  having: {
    kind: 'primary',
    accent: 'having',
    title: 'HAVING',
    badge: '> 120',
    meta: '8 → 5 groups',
    chips: ['kept groups'],
  },
  rejected: {
    kind: 'primary',
    accent: 'rejected',
    title: 'rejected',
    meta: '382 rows filtered out',
    dashed: true,
  },
  final: {
    kind: 'primary',
    accent: 'final',
    title: 'Final result',
    badge: 'OUTPUT',
    meta: '231 rows · 3 cols',
    chips: ['department', 'headcount'],
    preview: [
      ['Engineering', '42'],
      ['Design', '18'],
      ['Sales', '31'],
    ],
    focal: true,
  },
} as const

type CardId = keyof typeof CARD

function card(id: CardId, box: Rect): EntranceNodeSpec {
  const content = CARD[id]
  return { id, ...box, ...content } as EntranceNodeSpec
}

function pill(
  id: string,
  box: Rect,
  title: string,
  accent: LoaderAccent = 'select',
  icon: EntranceNodeSpec['icon'] = 'table',
): EntranceNodeSpec {
  return { id, ...box, kind: 'secondary', accent, title, icon }
}

function dot(id: string, x: number, y: number, accent: LoaderAccent = 'select', size = 8): EntranceNodeSpec {
  return { id, kind: 'peripheral', accent, title: id, x, y, w: size, h: size }
}

function link(
  id: string,
  from: string,
  to: string,
  weight: EdgeWeight = 'bridge',
  extra: Partial<EntranceEdgeSpec> = {},
): EntranceEdgeSpec {
  return { id, from, to, weight, accent: 'select', ...extra }
}

/* ------------------------------------------------------------------ */
/* Compositions                                                        */
/*                                                                     */
/* Each mode reserves a brand band (no card may enter it) and arranges  */
/* the query as a ring around the wordmark: sources and execution on    */
/* top, aggregation and output below.                                   */
/* ------------------------------------------------------------------ */

const DESKTOP: ModeSpec = {
  width: 1600,
  height: 1000,
  brand: { x: 380, y: 372, w: 840, h: 226 },
  nodes: [
    card('employees', { x: 90, y: 84, w: 250, h: 208 }),
    card('where', { x: 400, y: 116, w: 210, h: 118 }),
    card('rejected', { x: 400, y: 266, w: 186, h: 84 }),
    card('departments', { x: 726, y: 24, w: 240, h: 110 }),
    card('join', { x: 700, y: 166, w: 230, h: 124 }),
    card('group', { x: 1004, y: 620, w: 240, h: 124 }),
    card('having', { x: 1004, y: 790, w: 210, h: 118 }),
    card('final', { x: 600, y: 780, w: 270, h: 186 }),
    pill('idx', { x: 60, y: 300, w: 176, h: 54 }, 'index · dept_id', 'select', 'key'),
    pill('schema', { x: 60, y: 382, w: 190, h: 54 }, 'schema · 6 tables', 'select', 'database'),
    pill('rows', { x: 60, y: 464, w: 166, h: 54 }, 'rows · 1,284', 'source', 'rows'),
    pill('sqlite', { x: 60, y: 546, w: 176, h: 54 }, 'sqlite · wasm', 'join', 'bolt'),
    pill('scan', { x: 60, y: 628, w: 176, h: 54 }, 'scan · 4 steps', 'group', 'table'),
    pill('plan', { x: 1320, y: 250, w: 176, h: 54 }, 'plan · cached', 'where', 'bolt'),
    pill('tx', { x: 1320, y: 330, w: 166, h: 54 }, 'tx · local', 'having', 'database'),
    pill('res', { x: 1320, y: 620, w: 196, h: 54 }, 'result · 231 rows', 'final', 'rows'),
    pill('cache', { x: 1340, y: 790, w: 186, h: 54 }, 'index · salary', 'select', 'key'),
    dot('d1', 40, 30),
    dot('d2', 170, 26),
    dot('d3', 330, 40),
    dot('d4', 520, 40),
    dot('d5', 980, 30),
    dot('d6', 1180, 60),
    dot('d7', 1500, 120),
    dot('d8', 1560, 320),
    dot('d9', 1540, 560),
    dot('d10', 1520, 880),
    dot('d11', 1380, 960),
    dot('d12', 1120, 960),
    dot('d13', 860, 980),
    dot('d14', 300, 960),
    dot('d15', 120, 880),
    dot('d16', 30, 700),
    dot('d17', 20, 520),
    dot('d18', 30, 240),
  ],
  edges: [
    link('e-emp-where', 'employees', 'where', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'where' }),
    link('e-where-join', 'where', 'join', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'join' }),
    link('e-dept-join', 'departments', 'join', 'pipeline', { fromSide: 'bottom', toSide: 'top', accent: 'join' }),
    link('e-where-rej', 'where', 'rejected', 'pipeline', {
      fromSide: 'bottom',
      toSide: 'top',
      accent: 'rejected',
      dashed: true,
      label: 'removed',
    }),
    link('e-join-group', 'join', 'group', 'pipeline', {
      fromSide: 'right',
      toSide: 'right',
      accent: 'group',
      bulge: 1.15,
      label: 'dept_id',
    }),
    link('e-group-having', 'group', 'having', 'pipeline', { fromSide: 'bottom', toSide: 'top', accent: 'having' }),
    link('e-having-final', 'having', 'final', 'pipeline', {
      fromSide: 'left',
      toSide: 'right',
      accent: 'final',
      label: 'count > 120',
    }),
    link('b-idx-emp', 'idx', 'employees', 'bridge', { signal: true }),
    link('b-schema-where', 'schema', 'where', 'bridge'),
    link('b-rows-final', 'rows', 'final', 'bridge'),
    link('b-sqlite-rows', 'sqlite', 'rows', 'bridge'),
    link('b-plan-join', 'plan', 'join', 'bridge', { signal: true }),
    link('b-tx-group', 'tx', 'group', 'bridge'),
    link('b-res-group', 'res', 'group', 'bridge'),
    link('b-cache-having', 'cache', 'having', 'bridge'),
    link('b-schema-tx', 'schema', 'tx', 'bridge', { signal: true }),
    link('b-rows-res', 'rows', 'res', 'bridge', { signal: true }),
    ...dotLinks([
      ['d1', 'employees'],
      ['d2', 'employees'],
      ['d3', 'where'],
      ['d4', 'departments'],
      ['d5', 'departments'],
      ['d6', 'plan'],
      ['d7', 'plan'],
      ['d8', 'tx'],
      ['d9', 'res'],
      ['d10', 'cache'],
      ['d11', 'having'],
      ['d12', 'final'],
      ['d13', 'final'],
      ['d14', 'scan'],
      ['d15', 'scan'],
      ['d16', 'sqlite'],
      ['d17', 'rows'],
      ['d18', 'employees'],
    ]),
  ],
}

const COMPACT: ModeSpec = {
  width: 1180,
  height: 820,
  brand: { x: 140, y: 360, w: 620, h: 180 },
  nodes: [
    card('employees', { x: 40, y: 50, w: 240, h: 194 }),
    card('where', { x: 320, y: 70, w: 210, h: 118 }),
    card('rejected', { x: 320, y: 238, w: 186, h: 84 }),
    card('join', { x: 620, y: 120, w: 220, h: 124 }),
    card('group', { x: 600, y: 580, w: 230, h: 124 }),
    card('final', { x: 860, y: 600, w: 260, h: 176 }),
    pill('idx', { x: 40, y: 292, w: 170, h: 50 }, 'index · dept_id', 'select', 'key'),
    pill('schema', { x: 860, y: 330, w: 170, h: 50 }, 'schema', 'select', 'database'),
    pill('rows', { x: 860, y: 398, w: 170, h: 50 }, 'rows · 1,284', 'source', 'rows'),
    pill('sqlite', { x: 40, y: 580, w: 170, h: 50 }, 'sqlite · wasm', 'join', 'bolt'),
    pill('plan', { x: 40, y: 652, w: 170, h: 50 }, 'plan · cached', 'where', 'bolt'),
    dot('d1', 30, 30),
    dot('d2', 600, 20),
    dot('d3', 1140, 40),
    dot('d4', 1150, 520),
    dot('d5', 1130, 770),
    dot('d6', 600, 790),
    dot('d7', 60, 770),
    dot('d8', 20, 480),
    dot('d9', 20, 150),
    dot('d10', 700, 300),
  ],
  edges: [
    link('e-emp-where', 'employees', 'where', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'where' }),
    link('e-where-join', 'where', 'join', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'join' }),
    link('e-where-rej', 'where', 'rejected', 'pipeline', { fromSide: 'bottom', toSide: 'top', accent: 'rejected', dashed: true }),
    link('e-join-group', 'join', 'group', 'pipeline', {
      fromSide: 'right',
      toSide: 'right',
      accent: 'group',
      bulge: 1.1,
      label: 'dept_id',
    }),
    link('e-group-final', 'group', 'final', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'final' }),
    link('b-idx-where', 'idx', 'where', 'bridge', { signal: true }),
    link('b-schema-join', 'schema', 'join', 'bridge'),
    link('b-rows-group', 'rows', 'group', 'bridge', { signal: true }),
    link('b-sqlite-final', 'sqlite', 'final', 'bridge'),
    link('b-plan-group', 'plan', 'group', 'bridge'),
    ...dotLinks([
      ['d1', 'employees'],
      ['d2', 'join'],
      ['d3', 'rows'],
      ['d4', 'rows'],
      ['d5', 'final'],
      ['d6', 'group'],
      ['d7', 'sqlite'],
      ['d8', 'sqlite'],
      ['d9', 'employees'],
      ['d10', 'join'],
    ]),
  ],
}

const TABLET: ModeSpec = {
  width: 900,
  height: 1180,
  brand: { x: 110, y: 470, w: 680, h: 220 },
  nodes: [
    card('employees', { x: 50, y: 40, w: 300, h: 208 }),
    card('where', { x: 400, y: 70, w: 250, h: 118 }),
    card('departments', { x: 400, y: 226, w: 250, h: 110 }),
    card('join', { x: 650, y: 120, w: 230, h: 124 }),
    card('rejected', { x: 50, y: 268, w: 200, h: 84 }),
    card('group', { x: 560, y: 730, w: 260, h: 124 }),
    card('having', { x: 280, y: 760, w: 230, h: 118 }),
    card('final', { x: 560, y: 920, w: 270, h: 186 }),
    pill('idx', { x: 50, y: 396, w: 180, h: 50 }, 'index · dept_id', 'select', 'key'),
    pill('schema', { x: 400, y: 396, w: 180, h: 50 }, 'schema', 'select', 'database'),
    pill('rows', { x: 250, y: 700, w: 180, h: 50 }, 'rows · 1,284', 'source', 'rows'),
    pill('sqlite', { x: 50, y: 730, w: 180, h: 50 }, 'sqlite · wasm', 'join', 'bolt'),
    pill('plan', { x: 50, y: 880, w: 180, h: 50 }, 'plan · cached', 'where', 'bolt'),
    dot('d1', 20, 20),
    dot('d2', 420, 20),
    dot('d3', 870, 40),
    dot('d4', 870, 600),
    dot('d5', 870, 1120),
    dot('d6', 380, 1130),
    dot('d7', 20, 1100),
    dot('d8', 20, 600),
    dot('d9', 20, 180),
    dot('d10', 520, 700),
  ],
  edges: [
    link('e-emp-where', 'employees', 'where', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'where' }),
    link('e-where-join', 'where', 'join', 'pipeline', { fromSide: 'right', toSide: 'top', accent: 'join' }),
    link('e-dept-join', 'departments', 'join', 'pipeline', { fromSide: 'right', toSide: 'bottom', accent: 'join' }),
    link('e-where-rej', 'where', 'rejected', 'pipeline', {
      fromSide: 'bottom',
      toSide: 'top',
      accent: 'rejected',
      dashed: true,
    }),
    link('e-join-group', 'join', 'group', 'pipeline', { fromSide: 'bottom', toSide: 'top', accent: 'group' }),
    link('e-group-having', 'group', 'having', 'pipeline', { fromSide: 'left', toSide: 'right', accent: 'having' }),
    link('e-having-final', 'having', 'final', 'pipeline', { fromSide: 'bottom', toSide: 'left', accent: 'final' }),
    link('b-idx-emp', 'idx', 'employees', 'bridge', { signal: true }),
    link('b-schema-join', 'schema', 'join', 'bridge'),
    link('b-rows-group', 'rows', 'group', 'bridge', { signal: true }),
    link('b-sqlite-having', 'sqlite', 'having', 'bridge'),
    link('b-plan-final', 'plan', 'final', 'bridge'),
    ...dotLinks([
      ['d1', 'employees'],
      ['d2', 'where'],
      ['d3', 'join'],
      ['d4', 'rows'],
      ['d5', 'final'],
      ['d6', 'final'],
      ['d7', 'plan'],
      ['d8', 'sqlite'],
      ['d9', 'idx'],
      ['d10', 'group'],
    ]),
  ],
}

const PHONE: ModeSpec = {
  width: 430,
  height: 880,
  brand: { x: 16, y: 320, w: 398, h: 200 },
  nodes: [
    card('employees', { x: 24, y: 20, w: 250, h: 194 }),
    card('where', { x: 24, y: 210, w: 250, h: 110 }),
    card('group', { x: 24, y: 540, w: 250, h: 124 }),
    card('final', { x: 24, y: 684, w: 250, h: 176 }),
    pill('idx', { x: 292, y: 26, w: 120, h: 48 }, 'index', 'select', 'key'),
    pill('rows', { x: 292, y: 84, w: 120, h: 48 }, 'rows', 'source', 'rows'),
    pill('plan', { x: 292, y: 142, w: 120, h: 48 }, 'plan', 'where', 'bolt'),
    pill('sqlite', { x: 292, y: 700, w: 120, h: 48 }, 'sqlite', 'join', 'database'),
    pill('res', { x: 292, y: 758, w: 120, h: 48 }, 'result', 'final', 'table'),
    dot('d1', 10, 10),
    dot('d2', 404, 10),
    dot('d3', 404, 300),
    dot('d4', 404, 540),
    dot('d5', 10, 550),
    dot('d6', 10, 700),
    dot('d7', 404, 690),
    dot('d8', 200, 868),
  ],
  edges: [
    link('e-emp-where', 'employees', 'where', 'pipeline', { fromSide: 'bottom', toSide: 'top', accent: 'where' }),
    link('e-where-group', 'where', 'group', 'pipeline', {
      fromSide: 'right',
      toSide: 'right',
      accent: 'group',
      via: [
        { x: 394, y: 265 },
        { x: 394, y: 602 },
      ],
      label: 'dept_id',
    }),
    link('e-group-final', 'group', 'final', 'pipeline', { fromSide: 'bottom', toSide: 'top', accent: 'final' }),
    link('b-idx-where', 'idx', 'where', 'bridge', { signal: true }),
    link('b-rows-emp', 'rows', 'employees', 'bridge'),
    link('b-sqlite-final', 'sqlite', 'final', 'bridge', { signal: true }),
    link('b-res-group', 'res', 'group', 'bridge'),
    ...dotLinks([
      ['d1', 'employees'],
      ['d2', 'idx'],
      ['d3', 'where'],
      ['d4', 'group'],
      ['d5', 'where'],
      ['d6', 'final'],
      ['d7', 'final'],
      ['d8', 'final'],
    ]),
  ],
}

const LANDSCAPE: ModeSpec = {
  width: 1120,
  height: 480,
  brand: { x: 200, y: 16, w: 720, h: 130 },
  nodes: [
    card('employees', { x: 30, y: 180, w: 230, h: 184 }),
    card('where', { x: 292, y: 206, w: 220, h: 110 }),
    card('group', { x: 540, y: 206, w: 220, h: 110 }),
    card('final', { x: 790, y: 180, w: 250, h: 176 }),
    pill('idx', { x: 40, y: 388, w: 170, h: 50 }, 'index', 'select', 'key'),
    pill('rows', { x: 260, y: 400, w: 160, h: 50 }, 'rows · 1,284', 'source', 'rows'),
    pill('sqlite', { x: 820, y: 388, w: 180, h: 50 }, 'sqlite · wasm', 'join', 'bolt'),
    dot('d1', 20, 10),
    dot('d2', 150, 10),
    dot('d3', 1000, 20),
    dot('d4', 1100, 300),
    dot('d5', 1060, 440),
    dot('d6', 700, 450),
    dot('d7', 300, 450),
    dot('d8', 150, 340),
  ],
  edges: [
    link('e-emp-where', 'employees', 'where', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'where' }),
    link('e-where-group', 'where', 'group', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'group' }),
    link('e-group-final', 'group', 'final', 'pipeline', { fromSide: 'right', toSide: 'left', accent: 'final' }),
    link('b-idx-emp', 'idx', 'employees', 'bridge', { signal: true }),
    link('b-rows-where', 'rows', 'where', 'bridge'),
    link('b-sqlite-final', 'sqlite', 'final', 'bridge', { signal: true }),
    ...dotLinks([
      ['d1', 'employees'],
      ['d2', 'employees'],
      ['d3', 'final'],
      ['d4', 'final'],
      ['d5', 'sqlite'],
      ['d6', 'group'],
      ['d7', 'where'],
      ['d8', 'idx'],
    ]),
  ],
}

const MODES: Record<EntranceMode, ModeSpec> = {
  desktop: DESKTOP,
  compact: COMPACT,
  tablet: TABLET,
  phone: PHONE,
  landscape: LANDSCAPE,
}

function dotLinks(pairs: Array<[string, string]>): EntranceEdgeSpec[] {
  return pairs.map(([from, to], index) => ({
    id: `f-${from}-${to}-${index}`,
    from,
    to,
    accent: 'select',
    weight: 'faint' as const,
  }))
}

/* ------------------------------------------------------------------ */
/* Geometry                                                           */
/* ------------------------------------------------------------------ */

type Point = { x: number; y: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function boxesIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

function centerOf(box: Rect): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

function anchorOf(box: Rect, side: Side): Point {
  switch (side) {
    case 'left':
      return { x: box.x, y: box.y + box.h / 2 }
    case 'right':
      return { x: box.x + box.w, y: box.y + box.h / 2 }
    case 'top':
      return { x: box.x + box.w / 2, y: box.y }
    case 'bottom':
      return { x: box.x + box.w / 2, y: box.y + box.h }
  }
}

function normalOf(side: Side): Point {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
  }
}

function chooseSides(from: Rect, to: Rect): { fromSide: Side; toSide: Side } {
  const a = centerOf(from)
  const b = centerOf(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' }
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' }
}

function samplePolyline(points: Point[], t: number): Point {
  const lengths: number[] = []
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const length = Math.hypot(current.x - previous.x, current.y - previous.y)
    lengths.push(length)
    total += length
  }
  const target = total * t
  let travelled = 0
  for (let index = 1; index < points.length; index += 1) {
    const length = lengths[index - 1] ?? 0
    if (travelled + length >= target || index === points.length - 1) {
      const previous = points[index - 1]!
      const current = points[index]!
      const ratio = length === 0 ? 0 : (target - travelled) / length
      return { x: previous.x + (current.x - previous.x) * ratio, y: previous.y + (current.y - previous.y) * ratio }
    }
    travelled += length
  }
  return points[points.length - 1] ?? { x: 0, y: 0 }
}

function polylineMidpoint(points: Point[]): Point {
  let total = 0
  const lengths: number[] = []
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const length = Math.hypot(current.x - previous.x, current.y - previous.y)
    lengths.push(length)
    total += length
  }
  let travelled = 0
  const target = total / 2
  for (let index = 1; index < points.length; index += 1) {
    const length = lengths[index - 1] ?? 0
    if (travelled + length >= target) {
      const previous = points[index - 1]!
      const current = points[index]!
      const ratio = length === 0 ? 0 : (target - travelled) / length
      return { x: previous.x + (current.x - previous.x) * ratio, y: previous.y + (current.y - previous.y) * ratio }
    }
    travelled += length
  }
  return points[points.length - 1] ?? { x: 0, y: 0 }
}

interface EdgeShape {
  d: string
  arrow: { x: number; y: number; angle: number }
  mid: Point
  /** Sample the wire at t∈[0,1] from start to end (used to place labels). */
  at: (t: number) => Point
}

function shapeEdge(
  from: Rect,
  to: Rect,
  fromSide: Side,
  toSide: Side,
  bulge: number,
  via?: Array<{ x: number; y: number }>,
): EdgeShape {
  const start = anchorOf(from, fromSide)
  const end = anchorOf(to, toSide)

  if (via && via.length > 0) {
    const points = [start, ...via, end]
    const radius = 16
    let d = `M ${points[0]!.x} ${points[0]!.y}`
    for (let index = 1; index < points.length - 1; index += 1) {
      const previous = points[index - 1]!
      const corner = points[index]!
      const next = points[index + 1]!
      const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y)
      const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
      const cut = Math.max(0, Math.min(radius, inLength / 2, outLength / 2))
      const enter = inLength === 0 ? corner : {
        x: corner.x + ((previous.x - corner.x) / inLength) * cut,
        y: corner.y + ((previous.y - corner.y) / inLength) * cut,
      }
      const exit = outLength === 0 ? corner : {
        x: corner.x + ((next.x - corner.x) / outLength) * cut,
        y: corner.y + ((next.y - corner.y) / outLength) * cut,
      }
      d += ` L ${enter.x} ${enter.y} Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`
    }
    const last = points[points.length - 1]!
    d += ` L ${last.x} ${last.y}`
    const beforeLast = points[points.length - 2] ?? start
    const angle = (Math.atan2(end.y - beforeLast.y, end.x - beforeLast.x) * 180) / Math.PI
    const mid = polylineMidpoint(points)
    return { d, arrow: { x: end.x, y: end.y, angle }, mid, at: (t) => samplePolyline(points, t) }
  }

  const span = Math.hypot(end.x - start.x, end.y - start.y)
  const reach = clamp(span * 0.42 * bulge, 46, 360)
  const normalStart = normalOf(fromSide)
  const normalEnd = normalOf(toSide)
  const c1 = { x: start.x + normalStart.x * reach, y: start.y + normalStart.y * reach }
  const c2 = { x: end.x + normalEnd.x * reach, y: end.y + normalEnd.y * reach }
  const d = `M ${start.x} ${start.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`
  const angle = (Math.atan2(end.y - c2.y, end.x - c2.x) * 180) / Math.PI
  const mid = {
    x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8,
    y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8,
  }
  const at = (t: number): Point => {
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const e = t * t * t
    return {
      x: a * start.x + b * c1.x + c * c2.x + e * end.x,
      y: a * start.y + b * c1.y + c * c2.y + e * end.y,
    }
  }
  return { d, arrow: { x: end.x, y: end.y, angle }, mid, at }
}

/* ------------------------------------------------------------------ */
/* Builder                                                            */
/* ------------------------------------------------------------------ */

const PERIPHERAL_DELAY = 0.03
const SECONDARY_DELAY = 0.14
const PRIMARY_DELAY = 0.26
const SIGNAL_DURATION = 1.25

export function buildEntranceNetwork(mode: EntranceMode): EntranceNetwork {
  const spec = MODES[mode]
  const nodes: EntranceNode[] = []
  const counters: Record<NodeKind, number> = { primary: 0, secondary: 0, peripheral: 0 }

  for (const node of spec.nodes) {
    const index = counters[node.kind]
    counters[node.kind] = index + 1
    const delay =
      node.kind === 'primary'
        ? PRIMARY_DELAY + index * 0.09
        : node.kind === 'secondary'
          ? SECONDARY_DELAY + index * 0.045
          : PERIPHERAL_DELAY + index * 0.02
    nodes.push({ ...node, delay, done: delay + 0.5 })
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const sockets: Record<string, Side[]> = {}
  for (const node of nodes) {
    if (node.kind === 'primary') sockets[node.id] = []
  }

  const boxes: Rect[] = nodes.filter((node) => node.kind !== 'peripheral')
  const edges: EntranceEdge[] = []
  const signals: EntranceSignal[] = []
  const edgeCounters: Record<EdgeWeight, number> = { pipeline: 0, bridge: 0, faint: 0 }
  let signalIndex = 0

  for (const edge of spec.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue

    const chosen = chooseSides(from, to)
    const fromSide = edge.fromSide ?? chosen.fromSide
    const toSide = edge.toSide ?? chosen.toSide
    const shape = shapeEdge(from, to, fromSide, toSide, edge.bulge ?? 1, edge.via)

    const index = edgeCounters[edge.weight]
    edgeCounters[edge.weight] = index + 1
    const delay =
      edge.weight === 'pipeline' ? 0.62 + index * 0.085 : edge.weight === 'bridge' ? 0.8 + index * 0.04 : 0.5 + index * 0.015
    const duration = edge.weight === 'pipeline' ? 0.55 : edge.weight === 'bridge' ? 0.7 : 0.4

    const built: EntranceEdge = {
      ...edge,
      d: shape.d,
      delay,
      duration,
      arrow: shape.arrow,
    }

    if (edge.label !== undefined && edge.via === undefined) {
      // A wire tag is only placed where it is legible: never inside the
      // wordmark's reserved band and never on top of a card or pill.
      const width = edge.label.length * 5.6 + 14
      const band = spec.brand
      for (const t of [0.5, 0.34, 0.22, 0.66, 0.14]) {
        const point = shape.at(t)
        const rect = { x: point.x - width / 2 - 3, y: point.y - 11, w: width + 6, h: 22 }
        const hitsBand =
          rect.x < band.x + band.w + 16 &&
          rect.x + rect.w > band.x - 16 &&
          rect.y < band.y + band.h + 16 &&
          rect.y + rect.h > band.y - 16
        if (hitsBand) continue
        if (boxes.some((box) => boxesIntersect(rect, box))) continue
        built.labelPos = { x: point.x, y: point.y, width }
        break
      }
    }
    edges.push(built)

    if (edge.weight !== 'faint') {
      const list = sockets[edge.from]
      if (list && !list.includes(fromSide)) list.push(fromSide)
      const target = sockets[edge.to]
      if (target && !target.includes(toSide)) target.push(toSide)
    }

    const wantsSignal = edge.weight === 'pipeline' || (edge.weight === 'bridge' && edge.signal === true)
    if (wantsSignal) {
      signals.push({
        id: `signal-${edge.id}`,
        d: shape.d,
        delay: edge.weight === 'pipeline' ? delay + duration + 0.05 : 1.32 + signalIndex * 0.1,
        duration: SIGNAL_DURATION,
        accent: edge.accent,
      })
      signalIndex += 1
    }
  }

  return {
    mode,
    width: spec.width,
    height: spec.height,
    brand: spec.brand,
    nodes,
    edges,
    signals,
    sockets,
  }
}

export function pickEntranceMode(width: number, height: number): EntranceMode {
  const wide = width >= height * 1.12
  if (height < 560 && wide) return 'landscape'
  if (width >= 1300) return 'desktop'
  if (width >= 900) return 'compact'
  if (width >= 620) return 'tablet'
  return 'phone'
}

export const ENTRANCE_MODES: EntranceMode[] = ['desktop', 'compact', 'tablet', 'phone', 'landscape']