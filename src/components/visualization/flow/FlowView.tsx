import { memo, useMemo } from 'react'
import type { FlowGraph, FlowGraphNode, FlowGraphState } from '../../../types/flowGraph'
import { FlowCanvas } from './FlowCanvas'

/**
 * Flow View: renders the animated data-flow canvas from the graph and
 * the playback state. The workspace derives and owns the flow state so
 * the canvas and the floating inspector share one classification.
 */

interface FlowViewProps {
  graph: FlowGraph
  /** Per-node/per-edge playback status derived by the workspace. */
  flowState: FlowGraphState
  selectedNodeId: string | null
  /** True while the shared playback controller is running. */
  playing: boolean
  /**
   * Block-scoped stage key the user explicitly inspected (`q2:WHERE`).
   * Playback is paused in that case, so the relevant connection keeps
   * its data packets moving to show what that stage produced.
   */
  focusStageKey?: string | null
  onSelectNode: (node: FlowGraphNode) => void
  /** Clear the current selection (tap on empty canvas). */
  onDeselectNode?: () => void
}

export const FlowView = memo(function FlowView({
  graph,
  flowState,
  selectedNodeId,
  playing,
  focusStageKey = null,
  onSelectNode,
  onDeselectNode,
}: FlowViewProps) {
  // Live playback animates the edges of the running stage. When the user
  // parks on a completed stage, its real connections keep animating so
  // the inspected data flow stays legible.
  const packetEdgeIds = useMemo(() => {
    if (flowState.packetEdgeIds.length > 0) return flowState.packetEdgeIds
    if (focusStageKey === null) return []
    return graph.edges
      .filter(
        (edge) =>
          (edge.stageKey ?? edge.stage) === focusStageKey &&
          flowState.edges[edge.id] !== 'hidden' &&
          edge.curve.length >= 4,
      )
      .map((edge) => edge.id)
  }, [flowState.packetEdgeIds, flowState.edges, graph.edges, focusStageKey])

  return (
    <FlowCanvas
      graph={graph}
      nodeStatuses={flowState.nodes}
      edgeStatuses={flowState.edges}
      packetEdgeIds={packetEdgeIds}
      selectedNodeId={selectedNodeId}
      following={playing}
      focusStageKey={focusStageKey}
      onSelectNode={onSelectNode}
      onDeselectNode={onDeselectNode}
    />
  )
})
