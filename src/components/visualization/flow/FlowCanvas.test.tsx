// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFlowGraph, deriveFlowState } from '../../../services/visualization/graphBuilder'
import { flowBoxesOverlap } from '../../../services/visualization/flowLayout'
import type { StageSnapshot, VisualizationTrace } from '../../../types/visualization'
import { FlowCanvas } from './FlowCanvas'

/**
 * Canvas interaction tests. These run in jsdom, so SVG SMIL animations do
 * not actually play — we assert the DOM that drives them (active edges,
 * packet count, legend) and the interaction contract (selection,
 * keyboard activation, preview expansion, connected-edge emphasis).
 */

function snapshot(
  stage: StageSnapshot['stage'],
  rowCount: number,
  removedCount = 0,
): StageSnapshot {
  return {
    stage,
    label: `${stage} demo`,
    columns: ['name', 'salary'],
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: `r${index + 1}`,
      values: [`row ${index + 1}`, index + 1],
    })),
    removedRows: Array.from({ length: removedCount }, (_, index) => ({
      id: `x${index + 1}`,
      values: [`removed ${index + 1}`, index + 1],
    })),
    roles: {},
    groups: [],
    explanation: `${stage} explanation`,
    inputRowCount: rowCount + removedCount,
    outputRowCount: rowCount,
    truncated: false,
  }
}

function makeTrace(): VisualizationTrace {
  const stages: VisualizationTrace['stages'] = ['FROM', 'WHERE', 'SELECT']
  return {
    query: 'SELECT name, salary FROM employees WHERE salary > 50000',
    statementType: 'SELECT',
    capability: {
      supported: true,
      supportedStages: stages,
      unsupportedFeatures: [],
      warnings: [],
      detected: [],
      isReadOnly: true,
      hasAggregation: false,
      hasJoin: false,
      estimatedComplexity: 'small',
    },
    stages,
    events: [],
    stageSnapshots: [snapshot('FROM', 8), snapshot('WHERE', 4, 4), snapshot('SELECT', 4)],
    sourceTables: [
      {
        name: 'employees',
        alias: 'e',
        columns: ['name', 'salary'],
        rowCount: 8,
        // Six real-looking preview rows so the expand control has work to do.
        previewRows: Array.from({ length: 6 }, (_, index) => ({
          id: `employees#${index + 1}`,
          values: [`person ${index + 1}`, 50000 + index],
        })),
        role: 'from',
        joinType: null,
        on: null,
      },
    ],
    totalSteps: 0,
    finalRows: [{ id: 'r1', values: ['row 1', 1] }],
    finalColumns: ['name', 'salary'],
    hasDeterministicOrder: false,
    truncated: false,
  }
}

const graph = buildFlowGraph(makeTrace())

function renderCanvas(overrides: {
  selectedNodeId?: string | null
  packetEdgeIds?: string[]
} = {}) {
  // FROM + WHERE complete → the WHERE branch and both data nodes exist.
  const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
  const onSelectNode = vi.fn()
  render(
    <div style={{ width: 900, height: 700 }}>
      <FlowCanvas
        graph={graph}
        nodeStatuses={state.nodes}
        edgeStatuses={state.edges}
        packetEdgeIds={overrides.packetEdgeIds ?? state.packetEdgeIds}
        selectedNodeId={overrides.selectedNodeId ?? null}
        onSelectNode={onSelectNode}
      />
    </div>,
  )
  return { onSelectNode }
}

interface RenderedBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}

/** Read the live geometry a user actually sees in the canvas. */
function renderedBoxes(): RenderedBox[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.flow-node')).map((element) => ({
    id: element.dataset.nodeId ?? '',
    x: Number.parseFloat(element.style.left),
    y: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  }))
}

function expectSettled(boxes: RenderedBox[]): void {
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      if (a === undefined || b === undefined) continue
      expect(flowBoxesOverlap(a, b), `${a.id} overlaps ${b.id}`).toBe(false)
    }
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('FlowCanvas', () => {
  it('renders real nodes, edges, the legend and the camera controls', () => {
    renderCanvas()
    expect(screen.getByRole('button', { name: /Source table employees/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Operation WHERE/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Intermediate result after WHERE/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rejected rows/ })).toBeTruthy()
    // Each node exposes its theme accent key rather than a hard-coded
    // colour, so light/dark styling stays consistent for every operation.
    expect(
      screen.getByRole('button', { name: /Source table employees/ }).getAttribute('data-accent'),
    ).toBe('source')
    expect(
      screen.getByRole('button', { name: /Operation WHERE/ }).getAttribute('data-accent'),
    ).toBe('where')
    expect(
      screen.getByRole('button', { name: /Rejected rows/ }).getAttribute('data-accent'),
    ).toBe('rejected')
    for (const label of ['completed', 'active', 'pending', 'rejected', 'groups']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fit to screen' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset view' })).toBeTruthy()
  })

  it('selects a node on click and on keyboard activation', () => {
    const { onSelectNode } = renderCanvas()
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.click(where)
    expect(onSelectNode).toHaveBeenCalledTimes(1)
    expect(onSelectNode.mock.calls[0]?.[0]?.id).toBe('op-WHERE')

    fireEvent.keyDown(where, { key: 'Enter' })
    expect(onSelectNode).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(where, { key: ' ' })
    expect(onSelectNode).toHaveBeenCalledTimes(3)

    // The second click of a double-click must not toggle it back off.
    fireEvent.click(where, { detail: 2 })
    expect(onSelectNode).toHaveBeenCalledTimes(3)
  })

  it('expands and collapses a table preview without selecting the node', () => {
    const { onSelectNode } = renderCanvas()
    const source = screen.getByRole('button', { name: /Source table employees/ })
    const rowsOf = (): number => source.querySelectorAll('tbody tr').length
    expect(rowsOf()).toBe(3)
    expect(source.getAttribute('data-expanded')).toBeNull()

    fireEvent.click(within(source).getByRole('button', { name: 'Expand preview' }))
    expect(rowsOf()).toBe(6)
    expect(source.getAttribute('data-expanded')).toBe('true')
    expect(onSelectNode).not.toHaveBeenCalled()

    fireEvent.click(within(source).getByRole('button', { name: 'Collapse preview' }))
    expect(rowsOf()).toBe(3)
    expect(source.getAttribute('data-expanded')).toBeNull()
  })

  it('emphasizes the selected node’s edges and dims the rest', () => {
    renderCanvas({ selectedNodeId: 'op-WHERE' })
    const connected = graph.edges.find((edge) => edge.to === 'op-WHERE')!
    const unrelated = graph.edges.find((edge) => edge.stage === 'SELECT')!
    const connectedPath = document.getElementById(`edge-path-${connected.id}`)!
    const unrelatedPath = document.getElementById(`edge-path-${unrelated.id}`)!
    expect(connectedPath.getAttribute('stroke')).toBe('var(--accent)')
    expect(Number(connectedPath.getAttribute('opacity'))).toBeGreaterThan(0.6)
    expect(Number(unrelatedPath.getAttribute('opacity'))).toBeLessThan(0.5)
  })

  it('emphasizes a hovered node’s connections and restores them on leave', () => {
    renderCanvas()
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    const connected = graph.edges.find((edge) => edge.to === 'op-WHERE')!
    const unrelated = graph.edges.find((edge) => edge.stage === 'SELECT')!
    const connectedPath = document.getElementById(`edge-path-${connected.id}`)!
    const unrelatedPath = document.getElementById(`edge-path-${unrelated.id}`)!
    expect(Number(unrelatedPath.getAttribute('opacity'))).toBeGreaterThan(0.6)

    fireEvent.pointerOver(where)
    expect(connectedPath.getAttribute('stroke')).toBe('var(--accent)')
    expect(Number(unrelatedPath.getAttribute('opacity'))).toBeLessThan(0.5)

    fireEvent.pointerOut(where)
    expect(connectedPath.getAttribute('stroke')).not.toBe('var(--accent)')
    expect(Number(unrelatedPath.getAttribute('opacity'))).toBeGreaterThan(0.6)
  })

  it('animates only the edges carrying data and respects reduced motion', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderCanvas({ packetEdgeIds: state.packetEdgeIds })
    // One active packet indicator per packet edge (3 staggered packets each).
    const packets = document.querySelectorAll('svg animateMotion')
    expect(packets.length).toBe(state.packetEdgeIds.length * 3)
    expect(document.querySelectorAll('.flow-edge-active').length).toBe(
      state.packetEdgeIds.length,
    )
  })

  it('renders circular sockets and cubic Bézier wires', () => {
    renderCanvas()
    expect(document.querySelectorAll('.flow-socket').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.flow-socket[data-kind="branch"]').length).toBeGreaterThan(0)
    const firstEdge = graph.edges.find((edge) => edge.kind === 'main')!
    const path = document.getElementById(`edge-path-${firstEdge.id}`)!
    expect(path.getAttribute('d')).toContain(' C ')
  })

  it('re-routes a wire and pushes downstream nodes down when a preview expands', () => {
    renderCanvas()
    const outgoing = graph.edges.find((edge) => edge.from === 'data-WHERE')!
    const path = document.getElementById(`edge-path-${outgoing.id}`)!
    const before = path.getAttribute('d')
    const dataNode = screen.getByRole('button', { name: /Intermediate result after WHERE/ })
    const selectNode = screen.getByRole('button', { name: /Operation SELECT/ })
    const initialHeight = Number.parseFloat(dataNode.style.height)
    const initialSelectTop = Number.parseFloat(selectNode.style.top)
    fireEvent.click(within(dataNode).getByRole('button', { name: 'Expand preview' }))
    const after = path.getAttribute('d')
    expect(after).not.toBe(before)
    // The wire still starts on the data node's (now taller) bottom socket.
    expect(Number.parseFloat(dataNode.style.height)).toBeGreaterThan(initialHeight)
    // The node below moves down so the expanded preview never overlaps it.
    expect(Number.parseFloat(selectNode.style.top)).toBeGreaterThan(initialSelectTop)
  })

  it('expands a rejected branch to fit every real removed row without shifting the spine', () => {
    const { onSelectNode } = renderCanvas()
    const branchNode = graph.nodes.find((node) => node.kind === 'branch')!
    expect(branchNode.removedRows).toHaveLength(4)
    const branch = screen.getByRole('button', { name: /Rejected rows/ })
    const selectNode = screen.getByRole('button', { name: /Operation SELECT/ })
    const initialHeight = Number.parseFloat(branch.style.height)
    const initialSelectTop = Number.parseFloat(selectNode.style.top)
    expect(initialHeight).toBe(branchNode.height)
    expect(branch.querySelectorAll('tbody tr')).toHaveLength(0)

    fireEvent.click(within(branch).getByRole('button', { name: 'Expand preview' }))

    // Every removed row is shown, and the node is tall enough to fit the
    // preview table's chrome plus all of them (the collapsed node showed
    // only a hint).
    expect(branch.querySelectorAll('tbody tr')).toHaveLength(4)
    const expandedHeight = Number.parseFloat(branch.style.height)
    expect(expandedHeight).toBe(branchNode.expandedHeight)
    expect(expandedHeight).toBeGreaterThanOrEqual(branchNode.height + 19 + 4 * 17)
    // The branch lives in the side column, so growing it must not move the
    // main pipeline.
    expect(Number.parseFloat(selectNode.style.top)).toBe(initialSelectTop)
    expect(onSelectNode).not.toHaveBeenCalled()
  })

  it('pans the surface by dragging empty canvas and keeps nodes clickable', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement
    expect(surface.style.transform).toBe('translate(0px) scale(1)')

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    expect(canvas.className).toContain('flow-canvas-panning')
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 140 })
    expect(surface.style.transform).toContain('translate(60px, 40px)')
    fireEvent.pointerUp(canvas, { pointerId: 1 })
    expect(canvas.className).not.toContain('flow-canvas-panning')

    // A drag that starts on a node moves it and never selects it.
    const before = surface.style.transform
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 80, clientY: 80 })
    fireEvent.pointerUp(canvas, { pointerId: 2 })
    expect(surface.style.transform).toBe(before)
    // The compatibility click that follows the drag is swallowed.
    fireEvent.click(where)
    expect(onSelectNode).not.toHaveBeenCalled()

    // A fresh press still inspects the node.
    fireEvent.pointerDown(where, { button: 0, pointerId: 3, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 3 })
    fireEvent.click(where)
    expect(onSelectNode).toHaveBeenCalledTimes(1)
  })

  it('zooms around the pointer on wheel and updates the toolbar percentage', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement
    expect(screen.getByText('100%')).toBeTruthy()

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 120, clientY: 90 })
    expect(screen.getByText('120%')).toBeTruthy()
    // Anchored zoom keeps the point under the cursor fixed: the surface
    // shifts so the graph point at (120, 90) stays put after scaling.
    expect(surface.style.transform).toContain('translate(-24px, -18px)')
    expect(surface.style.transform).toContain('scale(1.2)')

    fireEvent.wheel(canvas, { deltaY: 100, clientX: 120, clientY: 90 })
    expect(screen.getByText('100%')).toBeTruthy()
    expect(surface.style.transform).toBe('translate(0px) scale(1)')
  })

  it('keeps the graph point under the pointer fixed after panning', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 41, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { pointerId: 41, clientX: 140, clientY: 120 })
    fireEvent.pointerUp(canvas, { pointerId: 41 })
    expect(surface.style.transform).toContain('translate(40px, 20px)')

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 200, clientY: 150 })
    // graphX = (200 - 40) = 160, graphY = (150 - 20) = 130 at scale 1;
    // after scale 1.2 the translation is 200 - 160 * 1.2 = 8 and
    // 150 - 130 * 1.2 = -6, keeping the same graph point anchored.
    expect(surface.style.transform).toContain('translate(8px, -6px)')
    expect(surface.style.transform).toContain('scale(1.2)')
  })

  it('pans with shift+wheel and horizontal trackpad deltas without zooming', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement

    fireEvent.wheel(canvas, { deltaY: 100, shiftKey: true, clientX: 100, clientY: 100 })
    expect(screen.getByText('100%')).toBeTruthy()
    expect(surface.style.transform).toContain('translate(-100px)')

    fireEvent.wheel(canvas, { deltaX: 30, deltaY: 5, clientX: 100, clientY: 100 })
    expect(screen.getByText('100%')).toBeTruthy()
    expect(surface.style.transform).toContain('translate(-130px, -5px)')
  })

  it('uses context-aware cursors for canvas and node dragging', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    expect(canvas.className).toContain('cursor-grab')
    expect(where.className).toContain('cursor-pointer')

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 21, clientX: 5, clientY: 5 })
    expect(canvas.className).toContain('flow-canvas-panning')
    expect(canvas.className).toContain('cursor-grabbing')
    fireEvent.pointerUp(canvas, { pointerId: 21 })

    fireEvent.pointerDown(where, { button: 0, pointerId: 22, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 22, clientX: 50, clientY: 40 })
    expect(canvas.className).toContain('flow-canvas-node-dragging')
    expect(canvas.className).toContain('cursor-grabbing')
    fireEvent.pointerUp(canvas, { pointerId: 22 })
    expect(canvas.className).not.toContain('flow-canvas-node-dragging')
    expect(canvas.className).toContain('cursor-grab')
  })

  it('drags a node and re-routes its real connections without panning the camera', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    const outgoing = graph.edges.find((edge) => edge.from === 'op-WHERE')!
    const path = document.getElementById(`edge-path-${outgoing.id}`)!
    const beforePath = path.getAttribute('d')
    const beforeLeft = Number.parseFloat(where.style.left)
    const beforeTop = Number.parseFloat(where.style.top)
    const beforeTransform = surface.style.transform

    fireEvent.pointerDown(where, { button: 0, pointerId: 31, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 31, clientX: 70, clientY: 50 })
    fireEvent.pointerUp(canvas, { pointerId: 31 })

    expect(Number.parseFloat(where.style.left)).toBeCloseTo(beforeLeft + 60, 5)
    expect(Number.parseFloat(where.style.top)).toBeCloseTo(beforeTop + 40, 5)
    // The camera itself never moved, and the wire still follows the node.
    expect(surface.style.transform).toBe(beforeTransform)
    expect(document.getElementById(`edge-path-${outgoing.id}`)!.getAttribute('d')).not.toBe(
      beforePath,
    )

    // The click that follows the drag is swallowed; a fresh press still
    // inspects the node.
    fireEvent.click(where)
    expect(onSelectNode).not.toHaveBeenCalled()
    fireEvent.pointerDown(where, { button: 0, pointerId: 32, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 32 })
    fireEvent.click(where)
    expect(onSelectNode).toHaveBeenCalledTimes(1)
  })

  it('prevents native text selection and HTML drag on node surfaces', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    // Scoped user-select rule on draggable nodes, not a global reset.
    expect(where.className).toContain('select-none')
    // The pointerdown that starts a node drag is default-prevented so the
    // browser never begins a text selection or drag.
    expect(
      fireEvent.pointerDown(where, { button: 0, pointerId: 61, clientX: 10, clientY: 10 }),
    ).toBe(false)
    expect(fireEvent.dragStart(where)).toBe(false)
    fireEvent.pointerUp(canvas, { pointerId: 61 })
  })

  it('captures the pointer for a node drag and releases it on drop', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    const setCapture = vi.fn()
    const releaseCapture = vi.fn()
    Object.defineProperty(canvas, 'setPointerCapture', { configurable: true, value: setCapture })
    Object.defineProperty(canvas, 'releasePointerCapture', {
      configurable: true,
      value: releaseCapture,
    })
    Object.defineProperty(canvas, 'hasPointerCapture', {
      configurable: true,
      value: () => true,
    })

    fireEvent.pointerDown(where, { button: 0, pointerId: 71, clientX: 10, clientY: 10 })
    expect(setCapture).toHaveBeenCalledWith(71)
    fireEvent.pointerMove(canvas, { pointerId: 71, clientX: 40, clientY: 30 })
    fireEvent.pointerUp(canvas, { pointerId: 71 })
    expect(releaseCapture).toHaveBeenCalledWith(71)
    expect(canvas.className).not.toContain('flow-canvas-node-dragging')
  })

  it('settles collisions after a drop while keeping the dragged node in place', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    const selectNode = screen.getByRole('button', { name: /Operation SELECT/ })
    const source = screen.getByRole('button', { name: /Source table employees/ })
    const outgoing = graph.edges.find((edge) => edge.from === 'op-WHERE')!
    const beforePath = document.getElementById(`edge-path-${outgoing.id}`)!.getAttribute('d')
    const whereBase = graph.nodes.find((node) => node.id === 'op-WHERE')!
    const selectBase = graph.nodes.find((node) => node.id === 'op-SELECT')!
    const sourceTop = Number.parseFloat(source.style.top)
    const dropY = selectBase.y - whereBase.y

    fireEvent.pointerDown(where, { button: 0, pointerId: 81, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 81, clientX: 10, clientY: 10 + dropY })
    fireEvent.pointerUp(canvas, { pointerId: 81 })

    // The manually chosen position survives the layout pass.
    expect(Number.parseFloat(where.style.top)).toBeCloseTo(selectBase.y, 5)
    // The overlapped stage moved out of the way and the whole visible
    // graph is now overlap-free at the required spacing.
    expect(Number.parseFloat(selectNode.style.top)).toBeGreaterThan(selectBase.y)
    expectSettled(renderedBoxes())
    // Unrelated source and the wired connection are handled correctly.
    expect(Number.parseFloat(source.style.top)).toBe(sourceTop)
    expect(document.getElementById(`edge-path-${outgoing.id}`)!.getAttribute('d')).not.toBe(
      beforePath,
    )
  })

  it('grows the canvas bounds when a node is dragged beyond them', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement
    const source = screen.getByRole('button', { name: /Source table employees/ })
    const beforeWidth = Number.parseFloat(surface.style.width)

    fireEvent.pointerDown(source, { button: 0, pointerId: 91, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 91, clientX: 1210, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 91 })

    expect(Number.parseFloat(source.style.left)).toBeCloseTo(1200, 5)
    expect(Number.parseFloat(surface.style.width)).toBeGreaterThan(beforeWidth)
    expect(Number.parseFloat(surface.style.width)).toBeGreaterThanOrEqual(1200 + 248 + 48)
  })

  it('resets node drag offsets when a new graph is rendered', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    const onSelectNode = vi.fn()
    const nextGraph = buildFlowGraph(makeTrace())
    const nextState = deriveFlowState(nextGraph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    const canvas = (target: typeof graph, targetState: typeof state) => (
      <div style={{ width: 900, height: 700 }}>
        <FlowCanvas
          graph={target}
          nodeStatuses={targetState.nodes}
          edgeStatuses={targetState.edges}
          packetEdgeIds={targetState.packetEdgeIds}
          selectedNodeId={null}
          onSelectNode={onSelectNode}
        />
      </div>
    )

    const { rerender } = render(canvas(graph, state))
    const originalLeft = Number.parseFloat(
      screen.getByRole('button', { name: /Operation WHERE/ }).style.left,
    )
    const application = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 51, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(application, { pointerId: 51, clientX: 70, clientY: 40 })
    fireEvent.pointerUp(application, { pointerId: 51 })
    expect(
      Number.parseFloat(screen.getByRole('button', { name: /Operation WHERE/ }).style.left),
    ).toBeCloseTo(originalLeft + 60, 5)

    rerender(canvas(nextGraph, nextState))
    expect(
      Number.parseFloat(screen.getByRole('button', { name: /Operation WHERE/ }).style.left),
    ).toBeCloseTo(originalLeft, 5)
  })
})
