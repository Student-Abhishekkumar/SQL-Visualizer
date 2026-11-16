import { useMemo } from 'react'
import type { FlowGraph, FlowGraphNode, FlowGraphState } from '../../../types/flowGraph'
import type { VisualizedStage } from '../../../types/visualization'
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
   * Stage the user explicitly inspected (clause strip, pipeline, node
   * click). Playback is paused in that case, so the relevant connection
   * keeps its data packets moving to show what that stage produced.
   */
  focusStage?: VisualizedStage | null
  onSelectNode: (node: FlowGraphNode) => void
}

export function FlowView({
  graph,
  flowState,
  selectedNodeId,
  playing,
  focusStage = null,
  onSelectNode,
}: FlowViewProps) {
  // Live playback animates the edges of the running stage. When the user
  // parks on a completed stage, its real connections keep animating so
  // the inspected data flow stays legible.
  const packetEdgeIds = useMemo(() => {
    if (flowState.packetEdgeIds.length > 0) return flowState.packetEdgeIds
    if (focusStage === null) return []
    return graph.edges
      .filter(
        (edge) =>
          edge.stage === focusStage &&
          flowState.edges[edge.id] !== 'hidden' &&
          edge.curve.length >= 4,
      )
      .map((edge) => edge.id)
  }, [flowState.packetEdgeIds, flowState.edges, graph.edges, focusStage])

  return (
    <FlowCanvas
      graph={graph}
      nodeStatuses={flowState.nodes}
      edgeStatuses={flowState.edges}
      packetEdgeIds={packetEdgeIds}
      selectedNodeId={selectedNodeId}
      following={playing}
      focusStage={focusStage}
      onSelectNode={onSelectNode}
    />
  )
}
