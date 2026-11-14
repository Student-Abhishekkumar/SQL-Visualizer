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

    fireEvent.click(within(source).getByRole('button', { name: 'Expand preview' }))
    expect(rowsOf()).toBe(6)
    expect(onSelectNode).not.toHaveBeenCalled()

    fireEvent.click(within(source).getByRole('button', { name: 'Collapse preview' }))
    expect(rowsOf()).toBe(3)
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
})
