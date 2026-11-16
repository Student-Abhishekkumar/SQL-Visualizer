import { describe, expect, it } from 'vitest'
import type { FlowGraph, FlowGraphEdge, FlowGraphNode } from '../../types/flowGraph'
import { traceUpstreamPath } from './flowPath'

/**
 * Pure traversal tests for selection-based path tracing. Synthetic graphs
 * keep the assertions about topology precise: linear chains, shared JOIN
 * inputs, grouped pipelines, rejected branches and cycles.
 */

function node(id: string): FlowGraphNode {
  return {
    id,
    kind: 'operation',
    stage: 'WHERE',
    label: id,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    sockets: [],
    revealsAt: null,
  }
}

function edge(
  from: string,
  to: string,
  overrides: Partial<FlowGraphEdge> = {},
): FlowGraphEdge {
  return {
    id: `edge-${from}-${to}`,
    from,
    to,
    kind: 'main',
    stage: 'WHERE',
    fromSocket: 'out',
    toSocket: 'in',
    curve: [],
    labelPoint: { x: 0, y: 0 },
    ...overrides,
  }
}

function makeGraph(edges: FlowGraphEdge[]): FlowGraph {
  const ids = new Set<string>()
  for (const item of edges) {
    ids.add(item.from)
    ids.add(item.to)
  }
  return {
    nodes: [...ids].map(node),
    edges,
    bounds: { width: 100, height: 100, flowWidth: 100 },
  }
}

function pairs(...list: Array<[string, string]>): FlowGraphEdge[] {
  return list.map(([from, to]) => edge(from, to))
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

describe('traceUpstreamPath', () => {
  it('traces a linear chain from its source to the selected node', () => {
    const graph = makeGraph(pairs(['FROM', 'WHERE'], ['WHERE', 'SELECT']))
    const path = traceUpstreamPath(graph, 'SELECT')

    expect(path.hasSelection).toBe(true)
    expect(sorted(path.nodeIds)).toEqual(['FROM', 'SELECT', 'WHERE'])
    expect(sorted(path.edgeIds)).toEqual(['edge-FROM-WHERE', 'edge-WHERE-SELECT'])
    // Breadth-first from the selected node: direct input first.
    expect(path.orderedEdgeIds).toEqual(['edge-WHERE-SELECT', 'edge-FROM-WHERE'])
    expect(path.edgeDepths.get('edge-WHERE-SELECT')).toBe(1)
    expect(path.edgeDepths.get('edge-FROM-WHERE')).toBe(2)
  })

  it('includes every source branch feeding a JOIN', () => {
    const graph = makeGraph(
      pairs(
        ['employees', 'JOIN'],
        ['departments', 'JOIN'],
        ['JOIN', 'RESULT'],
      ),
    )
    const joinPath = traceUpstreamPath(graph, 'JOIN')
    expect(sorted(joinPath.nodeIds)).toEqual(['JOIN', 'departments', 'employees'])
    expect(sorted(joinPath.edgeIds)).toEqual([
      'edge-departments-JOIN',
      'edge-employees-JOIN',
    ])
    // Downstream branches never appear in an upstream trace.
    expect(joinPath.nodeIds.has('RESULT')).toBe(false)

    const resultPath = traceUpstreamPath(graph, 'RESULT')
    expect(resultPath.nodeIds.has('employees')).toBe(true)
    expect(resultPath.nodeIds.has('departments')).toBe(true)
  })

  it('walks the full grouped pipeline into HAVING', () => {
    const chain = makeGraph(
      pairs(
        ['source', 'WHERE'],
        ['WHERE', 'GROUP_BY'],
        ['GROUP_BY', 'DATA_GROUP'],
        ['DATA_GROUP', 'HAVING'],
        ['HAVING', 'DATA_HAVING'],
        ['DATA_HAVING', 'SELECT'],
      ),
    )
    const path = traceUpstreamPath(chain, 'HAVING')
    expect(sorted(path.nodeIds)).toEqual([
      'DATA_GROUP',
      'GROUP_BY',
      'HAVING',
      'WHERE',
      'source',
    ])
    expect(path.nodeIds.has('DATA_HAVING')).toBe(false)
    expect(path.nodeIds.has('SELECT')).toBe(false)
    expect(path.edgeIds.has('edge-DATA_HAVING-SELECT')).toBe(false)
    expect(path.edgeIds.size).toBe(4)
  })

  it('traces the whole pipeline when the final result is selected', () => {
    const chain = makeGraph(
      pairs(['FROM', 'WHERE'], ['WHERE', 'SELECT'], ['SELECT', 'FINAL']),
    )
    const path = traceUpstreamPath(chain, 'FINAL')
    expect(sorted(path.nodeIds)).toEqual(['FINAL', 'FROM', 'SELECT', 'WHERE'])
    expect(sorted(path.edgeIds)).toEqual([
      'edge-FROM-WHERE',
      'edge-SELECT-FINAL',
      'edge-WHERE-SELECT',
    ])
  })

  it('keeps a selected rejected-row branch and leaves the accepted path out', () => {
    const graph = makeGraph([
      ...pairs(['FROM', 'WHERE']),
      edge('WHERE', 'branch', { kind: 'rejected', stage: 'WHERE' }),
      edge('WHERE', 'DATA_WHERE', { kind: 'main', stage: 'WHERE' }),
    ])
    const path = traceUpstreamPath(graph, 'branch')
    expect(sorted(path.nodeIds)).toEqual(['FROM', 'WHERE', 'branch'])
    expect(sorted(path.edgeIds)).toEqual(['edge-FROM-WHERE', 'edge-WHERE-branch'])
    expect(path.nodeIds.has('DATA_WHERE')).toBe(false)
    expect(path.edgeIds.has('edge-WHERE-DATA_WHERE')).toBe(false)
  })

  it('visits shared ancestors once and survives cycles', () => {
    // A deliberately malformed cycle: A → B → C → A.
    const graph = makeGraph(pairs(['A', 'B'], ['B', 'C'], ['C', 'A']))
    const path = traceUpstreamPath(graph, 'C')
    expect(sorted(path.nodeIds)).toEqual(['A', 'B', 'C'])
    expect(path.edgeIds.size).toBe(3)
    expect(path.orderedEdgeIds).toHaveLength(3)

    // A diamond visits the shared ancestor through both edges exactly once.
    const diamond = makeGraph(
      pairs(['ROOT', 'A'], ['ROOT', 'B'], ['A', 'C'], ['B', 'C']),
    )
    const diamondPath = traceUpstreamPath(diamond, 'C')
    expect(sorted(diamondPath.nodeIds)).toEqual(['A', 'B', 'C', 'ROOT'])
    expect(diamondPath.edgeIds.size).toBe(4)
  })

  it('returns an empty, stable path for no selection or a stale id', () => {
    const graph = makeGraph(pairs(['FROM', 'SELECT']))
    const none = traceUpstreamPath(graph, null)
    expect(none.hasSelection).toBe(false)
    expect(none.nodeIds.size).toBe(0)
    expect(none.edgeIds.size).toBe(0)

    const staleA = traceUpstreamPath(graph, 'missing')
    const staleB = traceUpstreamPath(graph, 'missing')
    expect(staleA.hasSelection).toBe(false)
    expect(staleA.nodeIds.size).toBe(0)
    // Memoized consumers can rely on a stable identity for the same graph.
    expect(staleB).toBe(staleA)
  })
})
