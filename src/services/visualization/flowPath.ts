/**
 * Selection-based upstream path tracing for the flow canvas.
 *
 * Selecting a node should explain where its data came from. This module
 * walks the real graph edges backwards from the selected node (never a
 * hard-coded SQL stage sequence) and returns every contributing node and
 * edge. Traversal is breadth-first with a visited set, so shared
 * ancestors are visited once and malformed/cyclic graphs cannot loop
 * forever.
 *
 * The result is computed from graph topology only, so it is reused while
 * nodes are dragged or panned and never re-traversed per animation frame.
 */

import type { FlowGraph, FlowGraphEdge } from '../../types/flowGraph'

export interface FlowUpstreamPath {
  /** True when the id resolves to a real node in this graph. */
  hasSelection: boolean
  /** The selected node plus every node that feeds it. */
  nodeIds: ReadonlySet<string>
  /** Every edge on a route into the selected node. */
  edgeIds: ReadonlySet<string>
  /** Edge ids in breadth-first order, closest to the selected node first. */
  orderedEdgeIds: readonly string[]
  /** 1-based distance from the selected node for each traced edge. */
  edgeDepths: ReadonlyMap<string, number>
}

const EMPTY_PATHS = new WeakMap<FlowGraph, FlowUpstreamPath>()

/** Empty result for no selection; stale selections reuse a cached copy. */
export function emptyUpstreamPath(): FlowUpstreamPath {
  return {
    hasSelection: false,
    nodeIds: new Set(),
    edgeIds: new Set(),
    orderedEdgeIds: [],
    edgeDepths: new Map(),
  }
}

/**
 * Trace every connection that carries data into `selectedNodeId`.
 *
 * Edges are followed in reverse (`to → from`), so selecting a JOIN finds
 * both source inputs, selecting a HAVING node walks back through GROUP BY
 * and its upstream operations, and selecting a rejected-row branch keeps
 * the rejected edge while leaving sibling branches out.
 */
export function traceUpstreamPath(
  graph: FlowGraph,
  selectedNodeId: string | null,
): FlowUpstreamPath {
  if (selectedNodeId === null) return emptyUpstreamPath()

  const knownNodes = new Set(graph.nodes.map((node) => node.id))
  if (!knownNodes.has(selectedNodeId)) {
    // A selection can outlive a graph replacement; reuse one empty
    // instance per graph so memoized consumers keep stable identities.
    let cached = EMPTY_PATHS.get(graph)
    if (cached === undefined) {
      cached = emptyUpstreamPath()
      EMPTY_PATHS.set(graph, cached)
    }
    return cached
  }

  // Reverse adjacency: for each node, the edges that end there.
  const incoming = new Map<string, FlowGraphEdge[]>()
  for (const edge of graph.edges) {
    const bucket = incoming.get(edge.to)
    if (bucket === undefined) incoming.set(edge.to, [edge])
    else bucket.push(edge)
  }

  const nodeIds = new Set<string>([selectedNodeId])
  const edgeIds = new Set<string>()
  const orderedEdgeIds: string[] = []
  const edgeDepths = new Map<string, number>()

  let frontier: string[] = [selectedNodeId]
  let depth = 0
  while (frontier.length > 0) {
    depth += 1
    const next: string[] = []
    for (const nodeId of frontier) {
      for (const edge of incoming.get(nodeId) ?? []) {
        if (edgeIds.has(edge.id)) continue
        edgeIds.add(edge.id)
        orderedEdgeIds.push(edge.id)
        edgeDepths.set(edge.id, depth)
        // Cycle protection: only enqueue nodes we have never traced.
        if (!nodeIds.has(edge.from) && knownNodes.has(edge.from)) {
          nodeIds.add(edge.from)
          next.push(edge.from)
        }
      }
    }
    frontier = next
  }

  return { hasSelection: true, nodeIds, edgeIds, orderedEdgeIds, edgeDepths }
}
