// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFlowGraph, deriveFlowState } from '../../../services/visualization/graphBuilder'
import type { StageSnapshot, VisualizationTrace } from '../../../types/visualization'
import { FlowCanvas } from './FlowCanvas'

/**
 * Reduced-motion regression: when the OS/browser asks for reduced motion
 * the canvas must keep every node and edge, but drop the moving packets
 * and the marching overlay. `motion` caches the preference in module
 * state, so this case lives in its own file to guarantee a clean
 * initialisation with `matches: true`.
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
        previewRows: Array.from({ length: 3 }, (_, index) => ({
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

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
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

describe('FlowCanvas reduced motion', () => {
  it('keeps nodes and edges but drops packets and the marching overlay', () => {
    const graph = buildFlowGraph(makeTrace())
    const state = deriveFlowState(graph, new Set(['FROM', 'WHERE']), 'SELECT', false)
    expect(state.packetEdgeIds.length).toBeGreaterThan(0)

    render(
      <div style={{ width: 900, height: 700 }}>
        <FlowCanvas
          graph={graph}
          nodeStatuses={state.nodes}
          edgeStatuses={state.edges}
          packetEdgeIds={state.packetEdgeIds}
          selectedNodeId={null}
          onSelectNode={vi.fn()}
        />
      </div>,
    )

    // Structure is intact…
    expect(screen.getByRole('button', { name: /Operation WHERE/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Rejected rows/ })).toBeTruthy()
    // …but nothing is in motion.
    expect(document.querySelectorAll('svg animateMotion').length).toBe(0)
    expect(document.querySelectorAll('.flow-edge-active').length).toBe(0)
  })
})
