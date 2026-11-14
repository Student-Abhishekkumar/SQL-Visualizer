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
  /** Elbow polyline anchor points (start → corner(s) → end). */
  points: Array<{ x: number; y: number }>
  /** Where to place the edge label (midpoint of the routed path). */
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
