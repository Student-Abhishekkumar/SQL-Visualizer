// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFlowGraph, deriveFlowState } from '../../../services/visualization/graphBuilder'
import { flowBoxesOverlap } from '../../../services/visualization/flowLayout'
import { traceUpstreamPath } from '../../../services/visualization/flowPath'
import type { FlowGraph } from '../../../types/flowGraph'
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

/** Two real source tables merging into a JOIN, for input-wire coverage. */
function makeJoinTrace(): VisualizationTrace {
  const base = makeTrace()
  const stages: VisualizationTrace['stages'] = ['FROM', 'JOIN', 'SELECT']
  return {
    ...base,
    query:
      'SELECT e.name, d.department_name FROM employees e INNER JOIN departments d ON d.id = e.department_id',
    stages,
    capability: {
      ...base.capability,
      supportedStages: stages,
      hasJoin: true,
    },
    stageSnapshots: [snapshot('FROM', 8), snapshot('JOIN', 8), snapshot('SELECT', 8)],
    sourceTables: [
      base.sourceTables[0]!,
      {
        name: 'departments',
        alias: 'd',
        columns: ['id', 'department_name'],
        rowCount: 3,
        previewRows: Array.from({ length: 3 }, (_, index) => ({
          id: `dept#${index + 1}`,
          values: [index + 1, `dept ${index + 1}`],
        })),
        role: 'join',
        joinType: 'INNER JOIN',
        on: 'd.id = e.department_id',
      },
    ],
  }
}

const joinGraph = buildFlowGraph(makeJoinTrace())

/** FROM → WHERE → GROUP BY → HAVING → SELECT, with real groups/branches. */
function makeGroupTrace(): VisualizationTrace {
  const base = makeTrace()
  const stages: VisualizationTrace['stages'] = [
    'FROM',
    'WHERE',
    'GROUP_BY',
    'HAVING',
    'SELECT',
  ]
  const group = (index: number): StageSnapshot['groups'][number] => ({
    index,
    key: `department ${index}`,
    keyValues: [index],
    rowIds: [`r${index}a`, `r${index}b`],
    aggregates: { 'COUNT(*)': 2 },
  })
  return {
    ...base,
    query:
      'SELECT department_id, COUNT(*) FROM employees WHERE salary > 0 GROUP BY department_id HAVING COUNT(*) > 1',
    stages,
    capability: {
      ...base.capability,
      supportedStages: stages,
      hasAggregation: true,
    },
    stageSnapshots: [
      snapshot('FROM', 8),
      snapshot('WHERE', 6, 2),
      { ...snapshot('GROUP_BY', 6), groups: [group(1), group(2), group(3)] },
      snapshot('HAVING', 4, 2),
      snapshot('SELECT', 4),
    ],
  }
}

const groupGraph = buildFlowGraph(makeGroupTrace())
const groupStages = new Set<StageSnapshot['stage']>([
  'FROM',
  'WHERE',
  'GROUP_BY',
  'HAVING',
  'SELECT',
])

function renderCanvas(overrides: {
  selectedNodeId?: string | null
  packetEdgeIds?: string[]
  completedStages?: StageSnapshot['stage'][]
  activeStage?: StageSnapshot['stage'] | null
} = {}) {
  const state = deriveFlowState(
    graph,
    new Set(overrides.completedStages ?? ['FROM', 'WHERE']),
    overrides.activeStage === undefined ? 'SELECT' : overrides.activeStage,
    false,
  )
  return renderGraph(graph, state, overrides)
}

function renderGraph(
  targetGraph: FlowGraph,
  state: ReturnType<typeof deriveFlowState>,
  overrides: { selectedNodeId?: string | null; packetEdgeIds?: string[] } = {},
) {
  const onSelectNode = vi.fn()
  render(
    <div style={{ width: 900, height: 700 }}>
      <FlowCanvas
        graph={targetGraph}
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

function readPath(edgeId: string): SVGPathElement {
  const path = document.getElementById(`edge-path-${edgeId}`)
  expect(path, `missing SVG path for ${edgeId}`).not.toBeNull()
  return path as unknown as SVGPathElement
}

/** Edge ids of the active hover trace, in paint order. */
function hoverPacketEdgeIds(): string[] {
  return [...document.querySelectorAll('.flow-packets g[data-mode="hover"]')].map(
    (group) => group.getAttribute('data-edge-id')!,
  )
}

/** Edge ids that the default full-pipeline animation should cover. */
function flowableEdgeIds(
  targetGraph: FlowGraph,
  state: ReturnType<typeof deriveFlowState>,
): string[] {
  return targetGraph.edges
    .filter(
      (edge) => state.edges[edge.id] === 'completed' || state.edges[edge.id] === 'active',
    )
    .map((edge) => edge.id)
}

/** Every hover packet must ride exactly one real edge path. */
function expectHoverPacketsOn(packetIds: string[]): void {
  for (const edgeId of packetIds) {
    const group = document.querySelector(
      `.flow-packets g[data-edge-id="${edgeId}"][data-mode="hover"]`,
    )
    expect(group, `missing hover packet for ${edgeId}`).not.toBeNull()
    expect(group!.querySelector('mpath')?.getAttribute('href')).toBe(`#edge-path-${edgeId}`)
    expect(group!.querySelectorAll('circle.flow-packet')).toHaveLength(3)
  }
}

/**
 * Regression guard for the "connections disappeared" report: every edge
 * must be a real cubic curve with a directional arrowhead, a readable
 * stroke and a zoom-independent width. The old `--border-strong` hairline
 * at 42% opacity was invisible against the canvas.
 */
function expectReadableWire(path: SVGPathElement): void {
  const d = path.getAttribute('d') ?? ''
  expect(d).toMatch(/^M\s-?[\d.]+/)
  expect(d).toContain(' C ')
  expect(d).not.toContain('NaN')
  expect(d).not.toContain('undefined')
  expect(path.getAttribute('marker-end')).toMatch(/^url\(#flow-arrow-/)
  expect(Number(path.getAttribute('opacity'))).toBeGreaterThanOrEqual(0.6)
  expect(Number(path.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(1.5)
  expect(path.getAttribute('stroke')).not.toBe('var(--border-strong)')
  expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke')
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

  it('stops the flow at a hovered WHERE and leaves downstream nodes still', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerOver(where)

    const expected = traceUpstreamPath(graph, 'op-WHERE')
    expect(expected.edgeIds.size).toBeGreaterThan(0)
    expect(hoverPacketEdgeIds().sort()).toEqual([...expected.edgeIds].sort())
    expectHoverPacketsOn(hoverPacketEdgeIds())
    // Hover suppresses the default pipeline animation everywhere else.
    expect(document.querySelectorAll('.flow-packets g[data-mode="playback"]')).toHaveLength(0)

    // FROM → WHERE animates; the accepted branch out of WHERE must not.
    const incoming = graph.edges.find((edge) => edge.to === 'op-WHERE')!
    expect(readPath(incoming.id).parentElement?.getAttribute('data-hover-path')).toBe('true')
    const outgoing = graph.edges.find(
      (edge) => edge.from === 'op-WHERE' && edge.kind === 'main',
    )!
    expect(expected.edgeIds.has(outgoing.id)).toBe(false)
    expect(readPath(outgoing.id).parentElement?.getAttribute('data-hover-path')).toBeNull()
    expect(hoverPacketEdgeIds()).not.toContain(outgoing.id)

    // The hovered node is prominent and is the trace destination.
    expect(where.getAttribute('data-hovered')).toBe('true')
    const canvas = screen.getByRole('application')
    expect(canvas.getAttribute('data-hovered-node')).toBe('op-WHERE')
    expect(canvas.getAttribute('data-trace-mode')).toBe('hover')
    // Downstream nodes stay visible, just unanimated.
    expect(
      screen.getByRole('button', { name: /Intermediate result after WHERE/ }),
    ).toBeInTheDocument()
  })

  it('animates every incoming branch when a JOIN is hovered', () => {
    const state = deriveFlowState(joinGraph, new Set(['FROM', 'JOIN', 'SELECT']), null, false)
    renderGraph(joinGraph, state)
    fireEvent.pointerOver(screen.getByRole('button', { name: /Operation JOIN/ }))

    const expected = traceUpstreamPath(joinGraph, 'op-JOIN')
    const inputs = joinGraph.edges.filter((edge) => edge.to === 'op-JOIN')
    expect(inputs).toHaveLength(2)
    for (const edge of inputs) {
      expect(expected.edgeIds.has(edge.id)).toBe(true)
      expect(readPath(edge.id).parentElement?.getAttribute('data-hover-path')).toBe('true')
    }
    expect(hoverPacketEdgeIds().sort()).toEqual([...expected.edgeIds].sort())
    for (const source of joinGraph.nodes.filter((node) => node.kind === 'source')) {
      expect(
        screen
          .getByRole('button', { name: new RegExp(`Source table ${source.label}`) })
          .getAttribute('data-upstream'),
      ).toBe('true')
    }
  })

  it('animates the rejected branch only when the rejected node is hovered', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const rejectedNode = screen.getByRole('button', { name: /Rejected rows/ })
    fireEvent.pointerOver(rejectedNode)

    const rejected = graph.edges.find((edge) => edge.kind === 'rejected')!
    const accepted = graph.edges.find(
      (edge) => edge.from === 'op-WHERE' && edge.kind === 'main',
    )!
    const incoming = graph.edges.find((edge) => edge.to === 'op-WHERE')!
    expect(readPath(rejected.id).parentElement?.getAttribute('data-hover-path')).toBe('true')
    expect(readPath(accepted.id).parentElement?.getAttribute('data-hover-path')).toBeNull()
    expect(hoverPacketEdgeIds()).toEqual(
      expect.arrayContaining([incoming.id, rejected.id]),
    )
    expect(hoverPacketEdgeIds()).not.toContain(accepted.id)
    expect(rejectedNode.getAttribute('data-hovered')).toBe('true')
    expect(rejectedNode.getAttribute('data-accent')).toBe('rejected')
  })

  it('animates only the accepted route when the accepted-rows node is hovered', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const acceptedNode = screen.getByRole('button', { name: /Intermediate result after WHERE/ })
    fireEvent.pointerOver(acceptedNode)

    const expected = traceUpstreamPath(graph, 'data-WHERE')
    const accepted = graph.edges.find(
      (edge) => edge.from === 'op-WHERE' && edge.kind === 'main',
    )!
    const rejected = graph.edges.find((edge) => edge.kind === 'rejected')!
    expect(expected.edgeIds.has(accepted.id)).toBe(true)
    expect(expected.edgeIds.has(rejected.id)).toBe(false)
    expect(readPath(accepted.id).parentElement?.getAttribute('data-hover-path')).toBe('true')
    expect(readPath(rejected.id).parentElement?.getAttribute('data-hover-path')).toBeNull()
    expect(hoverPacketEdgeIds()).not.toContain(rejected.id)
    expect(acceptedNode.getAttribute('data-hovered')).toBe('true')
  })

  it('rises through GROUP BY and HAVING upstream paths without duplicates', () => {
    const state = deriveFlowState(groupGraph, groupStages, null, false)
    renderGraph(groupGraph, state)
    const groupBy = screen.getByRole('button', { name: /Operation GROUP BY/ })
    fireEvent.pointerOver(groupBy)

    const groupExpected = traceUpstreamPath(groupGraph, 'op-GROUP_BY')
    expect(hoverPacketEdgeIds().sort()).toEqual([...groupExpected.edgeIds].sort())
    // Fan-out group members are downstream of GROUP BY, not upstream.
    for (const edge of groupGraph.edges.filter((edge) => edge.kind === 'group-member')) {
      expect(hoverPacketEdgeIds()).not.toContain(edge.id)
    }

    // Moving directly onto HAVING swaps the route in one update.
    const having = screen.getByRole('button', { name: /Operation HAVING/ })
    fireEvent.pointerOver(having)
    const havingExpected = traceUpstreamPath(groupGraph, 'op-HAVING')
    expect(havingExpected.edgeIds.size).toBeGreaterThan(groupExpected.edgeIds.size)
    expect(hoverPacketEdgeIds().sort()).toEqual([...havingExpected.edgeIds].sort())
    expectHoverPacketsOn(hoverPacketEdgeIds())
    expect(groupBy.getAttribute('data-hovered')).toBeNull()
    expect(having.getAttribute('data-hovered')).toBe('true')
    // The old route is replaced, never painted twice.
    expect(document.querySelectorAll('.flow-packets g[data-mode="hover"]')).toHaveLength(
      havingExpected.edgeIds.size,
    )
  })

  it('animates the complete pipeline when the final result is hovered', () => {
    const state = deriveFlowState(groupGraph, groupStages, null, false)
    renderGraph(groupGraph, state)
    fireEvent.pointerOver(screen.getByRole('button', { name: /Final result/ }))

    const expected = traceUpstreamPath(groupGraph, 'final')
    const mainEdges = groupGraph.edges.filter(
      (edge) => edge.kind === 'main' || edge.kind === 'final',
    )
    expect([...expected.edgeIds].sort()).toEqual(mainEdges.map((edge) => edge.id).sort())
    for (const edge of mainEdges) {
      expect(readPath(edge.id).parentElement?.getAttribute('data-hover-path')).toBe('true')
    }
    const sideEdges = groupGraph.edges.filter(
      (edge) => edge.kind === 'rejected' || edge.kind === 'group-member',
    )
    expect(sideEdges.length).toBeGreaterThan(0)
    for (const edge of sideEdges) {
      expect(readPath(edge.id).parentElement?.getAttribute('data-hover-path')).toBeNull()
      expect(hoverPacketEdgeIds()).not.toContain(edge.id)
    }
    expect(screen.getByRole('button', { name: /Final result/ }).getAttribute('data-hovered')).toBe(
      'true',
    )
  })

  it('restores the full pipeline when the pointer leaves a node', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerOver(where)
    expect(hoverPacketEdgeIds().length).toBeGreaterThan(0)

    fireEvent.pointerOut(where)
    expect(hoverPacketEdgeIds()).toHaveLength(0)
    expect(document.querySelectorAll('.flow-packets g[data-mode="playback"]')).toHaveLength(
      flowableEdgeIds(graph, state).length,
    )
    const canvas = screen.getByRole('application')
    expect(canvas.getAttribute('data-hovered-node')).toBeNull()
    expect(canvas.getAttribute('data-trace-mode')).toBeNull()
    expect(where.getAttribute('data-hovered')).toBeNull()
  })

  it('keeps the hover route stable while dragging a node', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerOver(where)
    const expected = traceUpstreamPath(graph, 'op-WHERE')

    fireEvent.pointerDown(where, { button: 0, pointerId: 71, clientX: 10, clientY: 10 })
    // Crossing another node mid-drag must not steal the inspected route.
    fireEvent.pointerOver(
      screen.getByRole('button', { name: /Intermediate result after WHERE/ }),
    )
    expect(canvas.getAttribute('data-hovered-node')).toBe('op-WHERE')
    expect(hoverPacketEdgeIds().sort()).toEqual([...expected.edgeIds].sort())

    fireEvent.pointerMove(canvas, { pointerId: 71, clientX: 10, clientY: 90 })
    fireEvent.pointerUp(canvas, { pointerId: 71 })
    expect(canvas.getAttribute('data-hovered-node')).toBe('op-WHERE')
    expect(hoverPacketEdgeIds().sort()).toEqual([...expected.edgeIds].sort())
  })

  it('keeps the hover trace when the pointer enters an interactive child', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const source = screen.getByRole('button', { name: /Source table employees/ })
    const sourceId = source.getAttribute('data-node-id')!
    fireEvent.pointerOver(source)
    const expected = traceUpstreamPath(graph, sourceId)
    expect(expected.hasSelection).toBe(true)

    const expand = within(source).getByRole('button', { name: 'Expand preview' })
    fireEvent.pointerOver(expand)
    fireEvent.click(expand)
    expect(
      document.querySelector('[role="application"]')?.getAttribute('data-hovered-node'),
    ).toBe(sourceId)
    expect(source.getAttribute('data-hovered')).toBe('true')
    expect(hoverPacketEdgeIds()).toHaveLength(0)
  })

  it('lets hover override a pinned selection and restores it on leave', () => {
    renderCanvas({ selectedNodeId: 'op-WHERE', completedStages: ['FROM', 'WHERE'] })
    const canvas = screen.getByRole('application')
    expect(canvas.getAttribute('data-trace-mode')).toBe('selection')

    const acceptedNode = screen.getByRole('button', { name: /Intermediate result after WHERE/ })
    fireEvent.pointerOver(acceptedNode)
    const hoverExpected = traceUpstreamPath(graph, 'data-WHERE')
    expect(canvas.getAttribute('data-trace-mode')).toBe('hover')
    expect(document.querySelectorAll('[data-selected-path]')).toHaveLength(0)
    expect(hoverPacketEdgeIds().sort()).toEqual([...hoverExpected.edgeIds].sort())
    // Pinned selection is remembered, not destroyed.
    expect(canvas.getAttribute('data-selected-node')).toBe('op-WHERE')

    fireEvent.pointerOut(acceptedNode)
    const selectionExpected = traceUpstreamPath(graph, 'op-WHERE')
    expect(canvas.getAttribute('data-trace-mode')).toBe('selection')
    expect(hoverPacketEdgeIds()).toHaveLength(0)
    for (const edgeId of selectionExpected.edgeIds) {
      expect(readPath(edgeId).parentElement?.getAttribute('data-selected-path')).toBe('true')
    }
  })

  it('keeps playback-driven animation while a node is hovered and restores it after', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderGraph(graph, state)
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerOver(where)

    const expected = traceUpstreamPath(graph, 'op-WHERE')
    expect(hoverPacketEdgeIds().sort()).toEqual([...expected.edgeIds].sort())
    // Playback's marching dashes still follow the simulator's active stage.
    expect(document.querySelectorAll('.flow-edge-active')).toHaveLength(
      state.packetEdgeIds.length,
    )
    for (const activeId of state.packetEdgeIds) {
      expect(hoverPacketEdgeIds()).not.toContain(activeId)
    }

    fireEvent.pointerOut(where)
    expect(document.querySelectorAll('.flow-packets g[data-mode="playback"]')).toHaveLength(
      flowableEdgeIds(graph, state).length,
    )
    for (const activeId of state.packetEdgeIds) {
      expect(
        document.querySelector(
          `.flow-packets g[data-edge-id="${activeId}"][data-mode="playback"]`,
        ),
      ).not.toBeNull()
    }
  })

  it('keeps hover animation working when playback is paused', () => {
    // Playback paused between stages: nothing is active, yet hovering a node
    // must still animate its upstream route.
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), null, false)
    renderGraph(graph, state)
    expect(state.packetEdgeIds).toHaveLength(0)

    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerOver(where)
    const expected = traceUpstreamPath(graph, 'op-WHERE')
    expect(expected.edgeIds.size).toBeGreaterThan(0)
    expect(hoverPacketEdgeIds().sort()).toEqual([...expected.edgeIds].sort())
    expectHoverPacketsOn(hoverPacketEdgeIds())
    // With no active stage there are neither playback streams nor marches.
    expect(document.querySelectorAll('.flow-packets g[data-mode="playback"]')).toHaveLength(0)
    expect(document.querySelectorAll('.flow-edge-active')).toHaveLength(0)
  })

  it('animates every connection that has produced data and respects reduced motion', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    renderCanvas({ packetEdgeIds: state.packetEdgeIds })
    const flowable = graph.edges.filter(
      (edge) => state.edges[edge.id] === 'completed' || state.edges[edge.id] === 'active',
    )
    // The whole executed pipeline is alive, not just the active stage.
    expect(flowable.length).toBeGreaterThan(state.packetEdgeIds.length)
    expect(document.querySelectorAll('svg animateMotion').length).toBe(flowable.length * 3)
    // Marching dashes remain tied to the simulator's active stage.
    expect(document.querySelectorAll('.flow-edge-active').length).toBe(
      state.packetEdgeIds.length,
    )
  })

  it('keeps pending connections visible but still until playback reaches them', () => {
    // FROM and JOIN have produced data, so both endpoints of the wire into
    // the not-yet-run SELECT exist. It must render as a connection without
    // animating ahead of the simulator.
    const state = deriveFlowState(joinGraph, new Set(['FROM', 'JOIN']), null, false)
    renderGraph(joinGraph, state)
    const pending = joinGraph.edges.filter((edge) => state.edges[edge.id] === 'pending')
    expect(pending.length).toBeGreaterThan(0)
    for (const edge of pending) {
      const path = readPath(edge.id)
      expect(path).toBeTruthy()
      expect(
        document.querySelector(`.flow-packets g[data-edge-id="${edge.id}"]`),
      ).toBeNull()
    }
    // Completed connections still animate in the same render.
    const flowable = joinGraph.edges.filter(
      (edge) => state.edges[edge.id] === 'completed' || state.edges[edge.id] === 'active',
    )
    expect(flowable.length).toBeGreaterThan(0)
    expect(document.querySelectorAll('svg animateMotion').length).toBe(flowable.length * 3)
  })

  it('renders circular sockets and cubic Bézier wires', () => {
    renderCanvas()
    expect(document.querySelectorAll('.flow-socket').length).toBeGreaterThan(0)
    expect(document.querySelectorAll('.flow-socket[data-kind="branch"]').length).toBeGreaterThan(0)
    const firstEdge = graph.edges.find((edge) => edge.kind === 'main')!
    const path = document.getElementById(`edge-path-${firstEdge.id}`)!
    expect(path.getAttribute('d')).toContain(' C ')
  })

  it('renders every visible edge as a readable cubic connection', () => {
    renderCanvas()
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    const visible = graph.edges.filter((edge) => state.edges[edge.id] !== 'hidden')
    expect(visible.length).toBeGreaterThan(0)
    for (const edge of visible) {
      expectReadableWire(readPath(edge.id))
    }
  })

  it('keeps pending JOIN inputs visible with directional arrowheads', () => {
    // Both source tables are visible from the start, so JOIN inputs exist
    // before the JOIN stage runs — exactly when the old faint hairline
    // made the graph look disconnected.
    const state = deriveFlowState(joinGraph, new Set(), null, false)
    renderGraph(joinGraph, state)
    const inputs = joinGraph.edges.filter((edge) => edge.to === 'op-JOIN')
    expect(inputs).toHaveLength(2)
    for (const edge of inputs) {
      expect(state.edges[edge.id]).toBe('pending')
      const path = readPath(edge.id)
      expectReadableWire(path)
      expect(path.getAttribute('stroke')).toBe('var(--flow-wire)')
      expect(path.getAttribute('marker-end')).toBe('url(#flow-arrow-idle)')
    }
  })

  it('keeps accepted and rejected WHERE branches visually distinct', () => {
    renderCanvas()
    const accepted = graph.edges.find(
      (edge) => edge.from === 'op-WHERE' && edge.kind === 'main',
    )!
    const rejected = graph.edges.find((edge) => edge.kind === 'rejected')!
    const acceptedPath = readPath(accepted.id)
    const rejectedPath = readPath(rejected.id)
    expectReadableWire(acceptedPath)
    expectReadableWire(rejectedPath)
    expect(acceptedPath.getAttribute('stroke')).toBe('var(--node-where)')
    expect(rejectedPath.getAttribute('stroke')).toBe('var(--node-rejected)')
    expect(rejectedPath.getAttribute('stroke-dasharray')).toBe('5 4')
  })

  it('paints animated packets above every wire and binds them to the real path', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    expect(state.packetEdgeIds.length).toBeGreaterThan(0)
    renderCanvas({ packetEdgeIds: state.packetEdgeIds })

    const svg = document.querySelector('[role="application"] svg')!
    const packetLayer = svg.querySelector('.flow-packets')
    expect(packetLayer).not.toBeNull()
    // The packet layer must come after every edge group in paint order.
    const children = [...svg.children]
    const packetIndex = children.indexOf(packetLayer as Element)
    const lastEdgeIndex = children.reduce(
      (last, child, index) => (child.classList.contains('flow-edge') ? index : last),
      -1,
    )
    expect(packetIndex).toBeGreaterThan(lastEdgeIndex)

    const groups = [...packetLayer!.querySelectorAll('g[data-edge-id]')]
    const flowable = graph.edges.filter(
      (edge) => state.edges[edge.id] === 'completed' || state.edges[edge.id] === 'active',
    )
    expect(groups).toHaveLength(flowable.length)
    for (const group of groups) {
      const edgeId = group.getAttribute('data-edge-id')!
      expect(readPath(edgeId)).toBeTruthy()
      const mpath = group.querySelector('mpath')!
      expect(mpath.getAttribute('href')).toBe(`#edge-path-${edgeId}`)
      expect(group.querySelectorAll('circle.flow-packet')).toHaveLength(3)
    }
  })

  it('keeps connections readable through dragging, settling and zoom', () => {
    renderCanvas()
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    const visible = graph.edges.filter((edge) => state.edges[edge.id] !== 'hidden')
    const before = new Map(visible.map((edge) => [edge.id, readPath(edge.id).getAttribute('d')]))

    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 51, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 51, clientX: 10, clientY: 130 })
    fireEvent.pointerUp(canvas, { pointerId: 51 })

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))

    for (const edge of visible) {
      expectReadableWire(readPath(edge.id))
    }
    const movedEdge = visible.find(
      (edge) => edge.from === 'op-WHERE' || edge.to === 'op-WHERE',
    )!
    expect(readPath(movedEdge.id).getAttribute('d')).not.toBe(before.get(movedEdge.id))
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

  it('fits a negative-position node without changing its coordinates', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    try {
      const singleGraph: FlowGraph = {
        ...graph,
        nodes: [{ ...graph.nodes[0]!, x: -200, y: -100, width: 200, height: 100 }],
        edges: [],
      }
      const state = deriveFlowState(singleGraph, new Set(['FROM']), 'FROM', false)
      renderGraph(singleGraph, state)
      const canvas = screen.getByRole('application')

      fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }))
      const surface = canvas.firstElementChild as HTMLElement
      expect(surface.style.transform).toBe('translate(620px, 410px) scale(2.2)')
      const node = screen.getByRole('button', { name: /Source table employees/ })
      expect(node.style.left).toBe('-200px')
      expect(node.style.top).toBe('-100px')
    } finally {
      width.mockRestore()
      height.mockRestore()
    }
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

  it('keeps a dragged node under the cursor at a non-default zoom', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    // The surface is scaled, so a screen-space drag must be converted into
    // graph space; 120 screen px at 120% zoom is 100 graph px.
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 120, clientY: 90 })
    expect(screen.getByText('120%')).toBeTruthy()
    const beforeLeft = Number.parseFloat(where.style.left)
    const beforeTop = Number.parseFloat(where.style.top)

    fireEvent.pointerDown(where, { button: 0, pointerId: 301, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 301, clientX: 130, clientY: 130 })
    fireEvent.pointerUp(canvas, { pointerId: 301 })

    expect(Number.parseFloat(where.style.left)).toBeCloseTo(beforeLeft + 100, 5)
    expect(Number.parseFloat(where.style.top)).toBeCloseTo(beforeTop + 100, 5)
  })

  it('allows left-of-origin drags at non-default zoom without clipping wire geometry', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const source = screen.getByRole('button', { name: /Source table employees/ })
    const sourceNode = graph.nodes.find((node) => node.table?.name === 'employees')!
    const outgoing = graph.edges.find((edge) => edge.from === sourceNode.id)!
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 120, clientY: 90 })
    expect(screen.getByText('120%')).toBeTruthy()

    fireEvent.pointerDown(source, { button: 0, pointerId: 901, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 901, clientX: -470, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 901 })

    // 480 screen px at 120% zoom is 400 graph px to the left of the origin.
    expect(Number.parseFloat(source.style.left)).toBeCloseTo(-400, 5)
    expect(document.getElementById(`edge-path-${outgoing.id}`)!.getAttribute('d')).toMatch(/^M -/)
    const svg = canvas.querySelector('svg')!
    expect(svg.classList.contains('overflow-visible')).toBe(true)
    expect(svg.classList.contains('pointer-events-none')).toBe(true)
    expect(onSelectNode).not.toHaveBeenCalled()

    // Dragging still does not select; a subsequent deliberate click does.
    fireEvent.pointerDown(source, { button: 0, pointerId: 902, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 902 })
    fireEvent.click(source)
    expect(onSelectNode).toHaveBeenCalledTimes(1)
  })

  it('pans normally after moving a node left of the origin', () => {
    renderCanvas()
    const canvas = screen.getByRole('application')
    const surface = canvas.firstElementChild as HTMLElement
    const source = screen.getByRole('button', { name: /Source table employees/ })

    fireEvent.pointerDown(source, { button: 0, pointerId: 903, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 903, clientX: -190, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 903 })
    expect(Number.parseFloat(source.style.left)).toBeCloseTo(-200, 5)

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 904, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { pointerId: 904, clientX: 160, clientY: 130 })
    fireEvent.pointerUp(canvas, { pointerId: 904 })
    expect(surface.style.transform).toBe('translate(60px, 30px) scale(1)')
    expect(Number.parseFloat(source.style.left)).toBeCloseTo(-200, 5)
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

  it('traces the complete upstream path into the selected operation', () => {
    const state = deriveFlowState(groupGraph, groupStages, null, false)
    renderGraph(groupGraph, state, { selectedNodeId: 'op-HAVING' })

    const expected = traceUpstreamPath(groupGraph, 'op-HAVING')
    expect(expected.edgeIds.size).toBeGreaterThan(0)
    for (const edgeId of expected.edgeIds) {
      const path = readPath(edgeId)
      expectReadableWire(path)
      expect(path.getAttribute('stroke')).toBe('var(--accent)')
      expect(path.getAttribute('marker-end')).toBe('url(#flow-arrow-selected)')
      expect(path.parentElement?.getAttribute('data-selected-path')).toBe('true')
    }

    // Outgoing connections do not feed the selected node and stay dimmed.
    const outgoing = groupGraph.edges.find((edge) => edge.from === 'op-HAVING')!
    expect(readPath(outgoing.id).parentElement?.getAttribute('data-selected-path')).toBeNull()
    expect(Number(readPath(outgoing.id).getAttribute('opacity'))).toBeLessThan(0.3)

    // Upstream nodes get a subtle rim; the destination is the prominent one.
    expect(
      screen.getByRole('button', { name: /Operation WHERE/ }).getAttribute('data-upstream'),
    ).toBe('true')
    const having = screen.getByRole('button', { name: /Operation HAVING/ })
    expect(having.getAttribute('data-selected')).toBe('true')
    expect(having.getAttribute('data-upstream')).toBeNull()

    // Exactly one animated stream per traced edge, bound to its real path.
    const groups = [
      ...document.querySelectorAll('.flow-packets g[data-mode="selection"]'),
    ]
    expect(groups).toHaveLength(expected.edgeIds.size)
    for (const group of groups) {
      const edgeId = group.getAttribute('data-edge-id')!
      expect(expected.edgeIds.has(edgeId)).toBe(true)
      expect(group.querySelector('mpath')?.getAttribute('href')).toBe(`#edge-path-${edgeId}`)
      expect(group.querySelectorAll('circle.flow-packet')).toHaveLength(3)
    }
  })

  it('traces both input branches into a selected JOIN', () => {
    const state = deriveFlowState(joinGraph, new Set(['FROM', 'JOIN', 'SELECT']), null, false)
    renderGraph(joinGraph, state, { selectedNodeId: 'op-JOIN' })

    const inputs = joinGraph.edges.filter((edge) => edge.to === 'op-JOIN')
    expect(inputs).toHaveLength(2)
    for (const edge of inputs) {
      expect(readPath(edge.id).parentElement?.getAttribute('data-selected-path')).toBe('true')
      expect(readPath(edge.id).getAttribute('marker-end')).toBe('url(#flow-arrow-selected)')
    }
    for (const source of joinGraph.nodes.filter((node) => node.kind === 'source')) {
      expect(
        screen
          .getByRole('button', { name: new RegExp(`Source table ${source.label}`) })
          .getAttribute('data-upstream'),
      ).toBe('true')
    }
    expect(
      document.querySelectorAll('.flow-packets g[data-mode="selection"]'),
    ).toHaveLength(inputs.length)
  })

  it('traces the entire main pipeline when the final result is selected', () => {
    const state = deriveFlowState(groupGraph, groupStages, null, false)
    renderGraph(groupGraph, state, { selectedNodeId: 'final' })

    const expected = traceUpstreamPath(groupGraph, 'final')
    const mainEdges = groupGraph.edges.filter(
      (edge) => edge.kind === 'main' || edge.kind === 'final',
    )
    expect([...expected.edgeIds].sort()).toEqual(mainEdges.map((edge) => edge.id).sort())
    for (const edge of mainEdges) {
      expect(readPath(edge.id).parentElement?.getAttribute('data-selected-path')).toBe('true')
    }

    // Rejected and group fan-outs are not part of the final-result path.
    const sideEdges = groupGraph.edges.filter(
      (edge) => edge.kind === 'rejected' || edge.kind === 'group-member',
    )
    expect(sideEdges.length).toBeGreaterThan(0)
    for (const edge of sideEdges) {
      expect(readPath(edge.id).parentElement?.getAttribute('data-selected-path')).toBeNull()
    }
    expect(
      screen.getByRole('button', { name: /Final result/ }).getAttribute('data-selected'),
    ).toBe('true')
    expect(
      document.querySelectorAll('.flow-packets g[data-mode="selection"]'),
    ).toHaveLength(expected.edgeIds.size)
  })

  it('traces the rejected-row branch when its destination is selected', () => {
    renderCanvas({ selectedNodeId: 'branch-WHERE' })

    const rejected = graph.edges.find((edge) => edge.kind === 'rejected')!
    const path = readPath(rejected.id)
    expect(path.parentElement?.getAttribute('data-selected-path')).toBe('true')
    // Branch semantics survive the trace: still dashed, now selection-coloured.
    expect(path.getAttribute('stroke-dasharray')).toBe('5 4')
    expect(path.getAttribute('marker-end')).toBe('url(#flow-arrow-selected)')

    // The accepted route does not lead to the rejected records.
    const accepted = graph.edges.find(
      (edge) => edge.from === 'op-WHERE' && edge.kind === 'main',
    )!
    expect(readPath(accepted.id).parentElement?.getAttribute('data-selected-path')).toBeNull()
    expect(
      screen.getByRole('button', { name: /Rejected rows/ }).getAttribute('data-selected'),
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: /Operation WHERE/ }).getAttribute('data-upstream'),
    ).toBe('true')
  })

  it('recalculates the trace immediately when another node is selected', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    const ui = (selected: string | null) => (
      <div style={{ width: 900, height: 700 }}>
        <FlowCanvas
          graph={graph}
          nodeStatuses={state.nodes}
          edgeStatuses={state.edges}
          packetEdgeIds={state.packetEdgeIds}
          selectedNodeId={selected}
          onSelectNode={vi.fn()}
        />
      </div>
    )
    const { rerender } = render(ui('branch-WHERE'))

    const rejected = graph.edges.find((edge) => edge.kind === 'rejected')!
    const incoming = graph.edges.find((edge) => edge.to === 'op-WHERE')!
    expect(readPath(rejected.id).parentElement?.getAttribute('data-selected-path')).toBe('true')

    rerender(ui('op-WHERE'))
    expect(readPath(rejected.id).parentElement?.getAttribute('data-selected-path')).toBeNull()
    expect(readPath(incoming.id).parentElement?.getAttribute('data-selected-path')).toBe('true')
    const groups = [
      ...document.querySelectorAll('.flow-packets g[data-mode="selection"]'),
    ]
    expect(groups.map((group) => group.getAttribute('data-edge-id'))).toEqual([incoming.id])
  })

  it('restores playback-driven wires when the selection is cleared', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    const ui = (selected: string | null) => (
      <div style={{ width: 900, height: 700 }}>
        <FlowCanvas
          graph={graph}
          nodeStatuses={state.nodes}
          edgeStatuses={state.edges}
          packetEdgeIds={state.packetEdgeIds}
          selectedNodeId={selected}
          onSelectNode={vi.fn()}
        />
      </div>
    )
    const { rerender } = render(ui('branch-WHERE'))
    const active = graph.edges.find(
      (edge) => edge.from === 'data-WHERE' && edge.to === 'op-SELECT',
    )!
    expect(Number(readPath(active.id).getAttribute('opacity'))).toBeLessThan(0.3)

    rerender(ui(null))
    expect(document.querySelector('[data-selected-path]')).toBeNull()
    expect(document.querySelectorAll('.flow-packets g[data-mode="selection"]')).toHaveLength(0)
    const flowable = graph.edges.filter(
      (edge) => state.edges[edge.id] === 'completed' || state.edges[edge.id] === 'active',
    )
    expect(document.querySelectorAll('.flow-packets g[data-mode="playback"]')).toHaveLength(
      flowable.length,
    )
    expect(Number(readPath(active.id).getAttribute('opacity'))).toBeGreaterThan(0.6)
    expect(
      screen.getByRole('button', { name: /Operation WHERE/ }).getAttribute('data-upstream'),
    ).toBeNull()
    expect(
      document.querySelector('[role="application"]')?.getAttribute('data-selected-node'),
    ).toBeNull()
  })

  it('keeps the traced path bound to live geometry after a node is dragged', () => {
    const state = deriveFlowState(groupGraph, groupStages, null, false)
    renderGraph(groupGraph, state, { selectedNodeId: 'op-HAVING' })

    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    const incoming = groupGraph.edges.find((edge) => edge.to === 'op-WHERE')!
    const before = readPath(incoming.id).getAttribute('d')
    const canvas = screen.getByRole('application')

    fireEvent.pointerDown(where, { button: 0, pointerId: 201, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 201, clientX: 80, clientY: 70 })
    fireEvent.pointerUp(canvas, { pointerId: 201 })

    expect(readPath(incoming.id).getAttribute('d')).not.toBe(before)
    expect(readPath(incoming.id).parentElement?.getAttribute('data-selected-path')).toBe('true')
    const group = document.querySelector(
      `.flow-packets g[data-edge-id="${incoming.id}"]`,
    )
    expect(group?.querySelector('mpath')?.getAttribute('href')).toBe(
      `#edge-path-${incoming.id}`,
    )
    // Topology did not change, so the upstream rim survives the drag.
    expect(
      screen.getByRole('button', { name: /Source table employees/ }).getAttribute('data-upstream'),
    ).toBe('true')
    expect(
      screen.getByRole('button', { name: /Operation HAVING/ }).getAttribute('data-selected'),
    ).toBe('true')
  })

  it('runs selection and playback particles together without duplicate streams', () => {
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    expect(state.packetEdgeIds.length).toBeGreaterThan(0)
    const ui = (selected: string | null) => (
      <div style={{ width: 900, height: 700 }}>
        <FlowCanvas
          graph={graph}
          nodeStatuses={state.nodes}
          edgeStatuses={state.edges}
          packetEdgeIds={state.packetEdgeIds}
          selectedNodeId={selected}
          onSelectNode={vi.fn()}
        />
      </div>
    )
    const { rerender } = render(ui('op-WHERE'))

    const first = traceUpstreamPath(graph, 'op-WHERE')
    const firstUnion = new Set([...first.edgeIds, ...state.packetEdgeIds])
    const firstGroups = [
      ...document.querySelectorAll('.flow-packets g[data-edge-id]'),
    ]
    expect(firstGroups).toHaveLength(firstUnion.size)
    expect(new Set(firstGroups.map((group) => group.getAttribute('data-edge-id'))).size).toBe(
      firstGroups.length,
    )
    expect(
      document.querySelectorAll('.flow-packets g[data-mode="selection"]'),
    ).toHaveLength(first.edgeIds.size)
    expect(
      document.querySelectorAll('.flow-packets g[data-mode="playback"]'),
    ).toHaveLength(state.packetEdgeIds.length)

    // Selecting the active operation overlaps playback; the shared edge
    // must render one stream, owned by the selection trace.
    rerender(ui('op-SELECT'))
    const selected = traceUpstreamPath(graph, 'op-SELECT')
    const overlap = [...selected.edgeIds].filter((edgeId) =>
      state.packetEdgeIds.includes(edgeId),
    )
    expect(overlap.length).toBeGreaterThan(0)
    const merged = new Set([...selected.edgeIds, ...state.packetEdgeIds])
    expect(document.querySelectorAll('.flow-packets g[data-edge-id]')).toHaveLength(merged.size)
    for (const edgeId of overlap) {
      const groups = [
        ...document.querySelectorAll(`.flow-packets g[data-edge-id="${edgeId}"]`),
      ]
      expect(groups).toHaveLength(1)
      expect(groups[0]?.getAttribute('data-mode')).toBe('selection')
      expect(groups[0]?.querySelectorAll('circle.flow-packet')).toHaveLength(3)
      // The traced wire must not also carry the stage-coloured marching
      // overlay: the selection stream owns direction and colour there.
      const tracedGroup = document.querySelector(
        `.flow-edge[data-selected-path="true"] path[id="edge-path-${edgeId}"]`,
      )?.parentElement
      expect(tracedGroup?.querySelector('.flow-edge-active')).toBeNull()
      expect(tracedGroup?.querySelector('path[id^="edge-path-"]')?.getAttribute('stroke')).toBe(
        'var(--accent)',
      )
    }
    // Live playback still marches along edges that are not on the trace.
    const playbackOnly = state.packetEdgeIds.filter((edgeId) => !selected.edgeIds.has(edgeId))
    expect(document.querySelectorAll('.flow-edge-active')).toHaveLength(playbackOnly.length)
    expect(document.querySelectorAll('[data-selected-path="true"] .flow-edge-active')).toHaveLength(0)
  })

  it('selects on a click without starting a drag', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 211, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerId: 211 })
    fireEvent.click(where)
    expect(onSelectNode).toHaveBeenCalledTimes(1)
    expect(canvas.className).not.toContain('flow-canvas-node-dragging')
  })

  it('selects on pointer release with no click event (pointer capture retargets it)', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 212, clientX: 10, clientY: 10 })
    // No `click` is fired: in a real browser the container's pointer capture
    // retargets it away from the node, so selection cannot depend on onClick.
    fireEvent.pointerUp(canvas, { pointerId: 212 })
    expect(onSelectNode).toHaveBeenCalledTimes(1)
    expect(onSelectNode.mock.calls[0]?.[0]?.id).toBe('op-WHERE')
  })

  it('does not select when the pointer moves beyond the click threshold', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 213, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerId: 213, clientX: 40, clientY: 40 })
    fireEvent.pointerUp(canvas, { pointerId: 213 })
    expect(onSelectNode).not.toHaveBeenCalled()
  })

  it('does not select when the pointer interaction is cancelled', () => {
    const { onSelectNode } = renderCanvas()
    const canvas = screen.getByRole('application')
    const where = screen.getByRole('button', { name: /Operation WHERE/ })
    fireEvent.pointerDown(where, { button: 0, pointerId: 214, clientX: 10, clientY: 10 })
    fireEvent.pointerCancel(canvas, { pointerId: 214 })
    expect(onSelectNode).not.toHaveBeenCalled()
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

describe('FlowCanvas — nested query source', () => {
  const base = makeTrace()
  const nestedTrace: VisualizationTrace = {
    ...base,
    sourceTables: [
      ...base.sourceTables,
      {
        name: 'Scalar subquery · AVG(salary)',
        alias: null,
        columns: ['AVG(salary)'],
        rowCount: 1,
        previewRows: [{ id: 'q#r1', values: [54250] }],
        role: 'subquery',
        joinType: null,
        on: null,
        queryId: 'q2',
        consumerStage: 'WHERE',
      },
    ],
    nestedQueries: [
      {
        id: 'q2',
        kind: 'scalar',
        label: 'Scalar subquery · AVG(salary)',
        sql: 'SELECT AVG(salary) FROM employees',
        stageSnapshots: [],
        finalColumns: ['AVG(salary)'],
        finalRows: [{ id: 'q#r1', values: [54250] }],
        parentStage: 'WHERE',
        correlated: false,
      },
    ],
  }
  const subqueryGraph = buildFlowGraph(nestedTrace)

  it('renders the nested result as an inspectable source with a SUBQUERY badge', () => {
    renderGraph(subqueryGraph, deriveFlowState(subqueryGraph, new Set(['FROM']), null, false))
    expect(screen.getByText('SUBQUERY')).toBeInTheDocument()
    expect(screen.getByText('computed first')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /Nested query result Scalar subquery/ }),
    ).toBeInTheDocument()
  })
})
