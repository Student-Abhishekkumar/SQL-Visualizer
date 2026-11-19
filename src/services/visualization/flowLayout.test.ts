import { describe, expect, it } from 'vitest'
import {
  FLOW_LAYOUT_GAP_X,
  FLOW_LAYOUT_GAP_Y,
  fitFlowLayout,
  flowBoxesOverlap,
  measureFlowFitBounds,
  measureFlowLayout,
  resolveFlowLayout,
  type FlowLayoutBox,
} from './flowLayout'

/**
 * Incremental layout tests. The solver must resolve only collisions
 * caused by a drop, never move the dragged node, and keep its output
 * deterministic.
 */

function box(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
  extra: Partial<FlowLayoutBox> = {},
): FlowLayoutBox {
  return { id, x, y, width, height, column: x, ...extra }
}

function position(map: Map<string, { x: number; y: number }>, id: string) {
  const value = map.get(id)
  if (value === undefined) throw new Error(`missing ${id}`)
  return value
}

function expectNoOverlaps(boxes: readonly FlowLayoutBox[], positions: Map<string, { x: number; y: number }>) {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      if (a === undefined || b === undefined) continue
      const aPos = position(positions, a.id)
      const bPos = position(positions, b.id)
      expect(
        flowBoxesOverlap(
          { ...aPos, width: a.width, height: a.height },
          { ...bPos, width: b.width, height: b.height },
        ),
        `${a.id} overlaps ${b.id}`,
      ).toBe(false)
    }
  }
}

describe('flowBoxesOverlap', () => {
  it('uses real widths and heights with a minimum spacing band', () => {
    const a = { x: 0, y: 0, width: 100, height: 80 }
    expect(flowBoxesOverlap(a, { x: 50, y: 40, width: 100, height: 80 })).toBe(true)
    // Exactly at the required clearance is allowed.
    expect(
      flowBoxesOverlap(a, {
        x: 100 + FLOW_LAYOUT_GAP_X,
        y: 0,
        width: 100,
        height: 80,
      }),
    ).toBe(false)
    expect(
      flowBoxesOverlap(a, {
        x: 0,
        y: 80 + FLOW_LAYOUT_GAP_Y,
        width: 100,
        height: 80,
      }),
    ).toBe(false)
    // One pixel closer than the clearance is a collision.
    expect(
      flowBoxesOverlap(a, {
        x: 100 + FLOW_LAYOUT_GAP_X - 1,
        y: 0,
        width: 100,
        height: 80,
      }),
    ).toBe(true)
  })
})

describe('resolveFlowLayout', () => {
  it('keeps the dropped node exactly where it was released', () => {
    const boxes = [
      box('pinned', 40, 40),
      box('neighbour', 60, 70),
      box('unrelated', 500, 500),
    ]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    expect(position(resolved, 'pinned')).toEqual({ x: 40, y: 40 })
    expect(position(resolved, 'unrelated')).toEqual({ x: 500, y: 500 })
    expect(position(resolved, 'neighbour')).not.toEqual({ x: 60, y: 70 })
    expectNoOverlaps(boxes, resolved)
  })

  it('only moves nodes reached by the collision chain', () => {
    const boxes = [box('pinned', 0, 0), box('neighbour', 30, 30), box('far', 400, 400)]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    expect(position(resolved, 'far')).toEqual({ x: 400, y: 400 })
  })

  it('cascades a vertical push until the column is clear', () => {
    const boxes = [
      box('pinned', 0, 0),
      box('middle', 0, 50),
      box('bottom', 0, 160),
    ]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    expect(position(resolved, 'pinned').y).toBe(0)
    expect(position(resolved, 'middle').y).toBeGreaterThan(50)
    expect(position(resolved, 'bottom').y).toBeGreaterThan(160)
    expectNoOverlaps(boxes, resolved)
  })

  it('preserves same-column ordering and only moves vertically', () => {
    const boxes = [box('pinned', 120, 100), box('below', 120, 140)]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    expect(position(resolved, 'below').x).toBe(120)
    expect(position(resolved, 'below').y).toBeGreaterThan(140)
    expectNoOverlaps(boxes, resolved)
  })

  it('accounts for expanded (tall) node heights', () => {
    const pinned = box('pinned', 0, 0, 100, 200)
    const neighbour = box('neighbour', 0, 180)
    const tall = resolveFlowLayout([pinned, neighbour], { pinnedId: 'pinned' })
    expect(position(tall, 'neighbour').y).toBeGreaterThan(180)

    const collapsed = resolveFlowLayout(
      [box('pinned', 0, 0, 100, 100), neighbour],
      { pinnedId: 'pinned' },
    )
    expect(position(collapsed, 'neighbour')).toEqual({ x: 0, y: 180 })
  })

  it('handles multiple source tables, a join, branches and a final node', () => {
    const boxes = [
      box('src-0-employees', 0, 16, 248, 152, { column: 0 }),
      box('src-1-departments', 0, 16, 248, 152, { column: 0 }),
      box('op-JOIN', 344, 100, 260, 78, { column: 344 }),
      box('branch-WHERE', 666, 210, 236, 58, { column: 666, manual: true }),
      box('op-WHERE', 344, 240, 260, 78, { column: 344 }),
      box('data-WHERE', 344, 350, 260, 128, { column: 344 }),
      box('final', 344, 520, 260, 136, { column: 344 }),
    ]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'src-1-departments' })
    expect(position(resolved, 'src-1-departments')).toEqual({ x: 0, y: 16 })
    // The untouched far branch and final node keep their exact slots
    // unless the cascade actually reaches them.
    expect(position(resolved, 'branch-WHERE')).toEqual({ x: 666, y: 210 })
    expectNoOverlaps(boxes, resolved)
  })

  it('allows collision resolution to move a neighbour left of the origin', () => {
    const boxes = [
      box('pinned', 0, 0),
      box('neighbour', -40, 0),
      box('far', 400, 400),
    ]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    expect(position(resolved, 'pinned')).toEqual({ x: 0, y: 0 })
    expect(position(resolved, 'neighbour')).toEqual({
      x: -100 - FLOW_LAYOUT_GAP_X,
      y: 0,
    })
    expect(position(resolved, 'far')).toEqual({ x: 400, y: 400 })
    expectNoOverlaps(boxes, resolved)
  })

  it('is deterministic for identical input', () => {
    const boxes = [
      box('pinned', 0, 0),
      box('a', 20, 20),
      box('b', 40, 40),
      box('c', 400, 400),
    ]
    const first = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    const second = resolveFlowLayout(boxes, { pinnedId: 'pinned' })
    expect([...first.entries()]).toEqual([...second.entries()])
  })

  it('settles a dense multi-column cluster without overlaps', () => {
    const boxes = [
      box('src-0', 0, 0, 248, 152),
      box('src-1', 0, 172, 248, 152),
      box('op-JOIN', 344, 60, 260, 78),
      box('branch-JOIN', 666, 40, 236, 58),
      box('data-JOIN', 344, 170, 260, 128),
      box('op-WHERE', 344, 330, 260, 78),
      box('branch-WHERE', 666, 330, 236, 58),
      box('data-WHERE', 344, 440, 260, 128),
      box('final', 344, 600, 260, 136),
      box('group-0', 666, 430, 236, 54),
      box('group-1', 666, 496, 236, 54),
    ]
    const resolved = resolveFlowLayout(boxes, { pinnedId: 'op-WHERE' })
    expect(position(resolved, 'op-WHERE')).toEqual({ x: 344, y: 330 })
    expectNoOverlaps(boxes, resolved)
  })
})

describe('fitFlowLayout', () => {
  const viewport = { width: 800, height: 600, padding: 30, minZoom: 0.22, maxZoom: 2.2 }

  it('includes negative X coordinates and complete node widths', () => {
    expect(measureFlowFitBounds([
      { x: -350, y: 40, width: 120, height: 60 },
      { x: 50, y: 100, width: 100, height: 80 },
    ])).toEqual({ left: -350, top: 40, right: 150, bottom: 180, width: 500, height: 140 })
  })

  it('includes negative Y coordinates and complete node heights', () => {
    expect(measureFlowFitBounds([
      { x: 40, y: -350, width: 120, height: 180 },
      { x: 100, y: 50, width: 100, height: 80 },
    ])).toEqual({ left: 40, top: -350, right: 200, bottom: 130, width: 160, height: 480 })
  })

  it('fits nodes in all four quadrants with viewport padding', () => {
    const nodes = [
      { x: -400, y: -300, width: 100, height: 100 },
      { x: 300, y: -200, width: 100, height: 100 },
      { x: -250, y: 250, width: 100, height: 100 },
      { x: 400, y: 350, width: 150, height: 100 },
    ]
    const camera = fitFlowLayout(nodes, { ...viewport, width: 1000, height: 800 })
    expect(camera).not.toBeNull()
    if (camera === null) return

    const bounds = measureFlowFitBounds(nodes)
    expect(bounds).not.toBeNull()
    if (bounds === null) return
    expect(camera.panY + bounds.top * camera.zoom).toBeCloseTo(30)
    expect(camera.panY + bounds.bottom * camera.zoom).toBeCloseTo(770)
    expect(camera.panX + bounds.left * camera.zoom).toBeGreaterThanOrEqual(30)
    expect(camera.panX + bounds.right * camera.zoom).toBeLessThanOrEqual(970)
  })

  it('uses large node extents rather than only their origins or centers', () => {
    const bounds = measureFlowFitBounds([
      { x: -80, y: -50, width: 600, height: 500 },
      { x: 20, y: 20, width: 40, height: 40 },
    ])
    expect(bounds).toMatchObject({ left: -80, top: -50, right: 520, bottom: 450 })
    expect(bounds?.width).toBe(600)
    expect(bounds?.height).toBe(500)
  })

  it('handles an empty graph without creating a camera', () => {
    expect(measureFlowFitBounds([])).toBeNull()
    expect(fitFlowLayout([], viewport)).toBeNull()
  })

  it('centres a single negative-position node and respects maximum zoom', () => {
    const camera = fitFlowLayout([{ x: -200, y: -100, width: 200, height: 100 }], viewport)
    expect(camera).toEqual({ zoom: 2.2, panX: 620, panY: 410 })
  })

  it('respects minimum zoom and never rearranges nodes while fitting', () => {
    const nodes = [
      { x: -5000, y: -4000, width: 100, height: 100 },
      { x: 5000, y: 4000, width: 100, height: 100 },
    ]
    const before = structuredClone(nodes)
    const camera = fitFlowLayout(nodes, viewport)
    expect(camera?.zoom).toBe(0.22)
    expect(nodes).toEqual(before)
  })
})

describe('measureFlowLayout', () => {
  it('recalculates bounds from live positions without shrinking below the minimum', () => {
    const minimum = { width: 500, height: 400, flowWidth: 450 }
    const before = measureFlowLayout(
      [
        { x: 0, y: 0, width: 100, height: 50 },
        { x: 400, y: 300, width: 100, height: 50, side: true },
      ],
      minimum,
    )
    expect(before.width).toBe(548)
    expect(before.height).toBe(400)
    expect(before.flowWidth).toBe(450)

    const after = measureFlowLayout(
      [{ x: 600, y: 320, width: 100, height: 50 }],
      minimum,
    )
    expect(after.width).toBe(748)
    expect(after.height).toBe(418)
    expect(after.flowWidth).toBe(728)
  })
})
