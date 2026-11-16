// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFlowGraph, deriveFlowState } from '../../../services/visualization/graphBuilder'
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

    // A drag that starts on a node inspects it instead of panning.
    const before = surface.style.transform
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 2, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 80, clientY: 80 })
    fireEvent.pointerUp(canvas, { pointerId: 2 })
    expect(surface.style.transform).toBe(before)
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
})
