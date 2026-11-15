import { useMemo } from 'react'
import { deriveFlowState } from '../../../services/visualization/graphBuilder'
import type { FlowGraph, FlowGraphNode } from '../../../types/flowGraph'
import type {
  VisualizationTrace,
  VisualizationViewState,
  VisualizedStage,
} from '../../../types/visualization'
import { FlowCanvas } from './FlowCanvas'

/**
 * Flow View: derives the playback state of the workspace-owned graph
 * from the shared playback controller and renders the animated
 * data-flow canvas. The graph itself is built by the workspace so node
 * selection can be resolved against the same instance.
 */

interface FlowViewProps {
  graph: FlowGraph
  trace: VisualizationTrace
  viewState: VisualizationViewState
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
  viewState,
  selectedNodeId,
  playing,
  focusStage = null,
  onSelectNode,
}: FlowViewProps) {
  const flowState = useMemo(
    () =>
      deriveFlowState(
        graph,
        new Set(viewState.completedStages.map((snapshot) => snapshot.stage)),
        viewState.activeStage,
        viewState.finished,
      ),
    [graph, viewState.completedStages, viewState.activeStage, viewState.finished],
  )

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
