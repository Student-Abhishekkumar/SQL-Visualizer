/**
 * Flow-graph contracts — V3.
 *
 * A FlowGraph is derived deterministically from a VisualizationTrace:
 * nodes reference real snapshots and real source-table metadata, edges
 * represent actual data dependencies. The same query and database state
 * always produce the same graph. Layout is computed here so it is
 * testable, but rendering stays in the components.
 *
 * Nothing in a graph node is invented: previews are real rows from the
 * trace, counts come from real snapshots, and nodes that only exist
 * after a stage runs are revealed by playback state, never pre-shown.
 */

import type {
  GroupSnapshot,
  StageSnapshot,
  TraceSourceTable,
  VisualizedRow,
  VisualizedStage,
} from './visualization'

export type FlowNodeKind = 'source' | 'operation' | 'data' | 'branch' | 'group' | 'final'

export type FlowEdgeKind = 'main' | 'join-input' | 'rejected' | 'group-member' | 'final'

/** Edge of a node that a wire attaches to. */
export type FlowSocketSide = 'top' | 'bottom' | 'left' | 'right'

/**
 * `data` sockets carry rows along the main pipeline; `branch` sockets
 * carry rows that leave it (rejected/skipped rows, GROUP BY members).
 * The renderer uses this to draw filled vs. hollow ports.
 */
export type FlowSocketKind = 'data' | 'branch'

/**
 * A deterministic connection point on a node. Positions are relative to
 * the node's top-left corner at its collapsed height, so wires can be
 * routed without ever measuring the DOM.
 */
export interface FlowSocket {
  id: string
  direction: 'input' | 'output'
  kind: FlowSocketKind
  side: FlowSocketSide
  /** Tiny port label, e.g. a table alias, "rows" or "rejected". */
  label?: string
  x: number
  y: number
}

export interface FlowGraphNode {
  id: string
  kind: FlowNodeKind
  /** Owning pipeline stage, null for the final node. */
  stage: VisualizedStage | null
  label: string
  /** Secondary line, e.g. a condition or column summary. */
  detail?: string
  /** Beginner-friendly one-line explanation of what this stage does. */
  hint?: string
  /** Layout position (top-left corner), computed by the builder. */
  x: number
  y: number
  width: number
  height: number
  /** Connection points, always sorted input(s) then output(s). */
  sockets: FlowSocket[]
  /**
   * Height when the node's real-row preview is expanded. Undefined when
   * the node has nothing more to show than its collapsed preview.
   */
  expandedHeight?: number
  /** True when the trace cannot faithfully visualize this stage. */
  unsupported?: boolean
  /** For source nodes: real table metadata from the trace. */
  table?: TraceSourceTable
  /** The real snapshot of the node's stage (operation/data/branch). */
  snapshot?: StageSnapshot
  /** For data nodes, the projected rows actually shown by this node. */
  rows?: VisualizedRow[]
  /** For branch nodes: the removed rows of the snapshot. */
  removedRows?: VisualizedRow[]
  /** For group nodes: the real group. */
  group?: GroupSnapshot
  /**
   * The stage whose completion reveals this node. Null = always
   * visible (e.g. source tables). Playback never shows a node before
   * its stage has actually produced the data.
   */
  revealsAt: VisualizedStage | null
  /** Whether this node feeds a rejected/skipped path. */
  isRejected?: boolean
}

export interface FlowGraphEdge {
  id: string
  from: string
  to: string
  kind: FlowEdgeKind
  /** Short label, e.g. "accepted" / "rejected". */
  label?: string
  /**
   * The stage whose completion activates this edge. The edge is drawn
   * (subdued) from the start but only carries animated packets while
   * its data is actually flowing.
   */
  stage: VisualizedStage | null
  /** Socket ids the wire attaches to on the source/target nodes. */
  fromSocket: string
  toSocket: string
  /**
   * Cubic Bézier control points: start → control1 → control2 → end.
   * Curve routing is computed from socket centres, so wires always meet
   * the ports exactly and can be re-routed when a node expands.
   */
  curve: Array<{ x: number; y: number }>
  /** Where to place the edge label (midpoint of the routed curve). */
  labelPoint?: { x: number; y: number }
}

export interface FlowGraph {
  nodes: FlowGraphNode[]
  edges: FlowGraphEdge[]
  /**
   * `width`/`height` cover every node (used for the SVG surface and
   * fit-to-screen). `flowWidth` covers only the main pipeline, so a
   * narrow viewport can start at a readable zoom with side branches
   * reachable by panning.
   */
  bounds: { width: number; height: number; flowWidth: number }
}

/** Per-node/per-edge playback status derived from the current position. */
export type FlowElementStatus = 'pending' | 'active' | 'completed' | 'hidden'

export interface FlowGraphState {
  nodes: Record<string, FlowElementStatus>
  edges: Record<string, FlowElementStatus>
  /** Edges that should carry animated data packets right now. */
  packetEdgeIds: string[]
}
