import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, Maximize2, Minus, Plus } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import type {
  FlowEdgeKind,
  FlowElementStatus,
  FlowGraph,
  FlowGraphEdge,
  FlowGraphNode,
} from '../../../types/flowGraph'
import {
  curveMidpoint,
  curvePath,
  nodeDisplayHeight,
  routeEdgeCurve,
} from '../../../services/visualization/flowGeometry'
import {
  fitFlowLayout,
  fitFlowLayoutWidth,
  FLOW_FIT_CLEARANCE,
  initialFlowLayout,
  measureFlowLayout,
  resolveFlowLayout,
} from '../../../services/visualization/flowLayout'
import { traceUpstreamPath } from '../../../services/visualization/flowPath'
import { FlowNodeView } from './FlowNodeView'
import {
  accentColor,
  NODE_ACCENT_KEYS,
  stageAccentKey,
  type NodeAccentKey,
} from './nodeAccent'

/**
 * Interactive animated data-flow canvas: HTML nodes on a pan/zoom
 * surface, SVG wires with Blender-style sockets, arrowheads and animated
 * data packets for the currently active connections. Packets are visual
 * indicators of data movement along a real dependency — they never
 * pretend to be a specific database row.
 */

const MIN_ZOOM = 0.22
const MAX_ZOOM = 2.2
const ZOOM_STEP = 1.2
/**
 * Floor for the first camera on a narrow (phone) viewport. A whole wide
 * pipeline fitted into 320-430 px shrinks node labels below legibility, so
 * the initial mobile view opens at a readable scale and the user pans.
 */
const MOBILE_INITIAL_MIN_ZOOM = 0.62
/** Viewport width below which the mobile camera floor applies. */
const MOBILE_VIEWPORT_MAX = 640
/**
 * A resize into this width also re-applies the readable floor. Kept below
 * MOBILE_VIEWPORT_MAX so a small desktop window still refits to show the
 * whole graph, while a real phone gets a legible view.
 */
const MOBILE_RESIZE_FLOOR_MAX = 480
const PACKETS_PER_EDGE = 3
/**
 * Pointer travel (px) that still counts as a click rather than a drag.
 * Pointer capture retargets the compatibility `click` event to the canvas,
 * so node selection must be decided on pointer release instead.
 */
const CLICK_MOVE_THRESHOLD = 5
/** Stable empty collections so memoized values keep their identity. */
const EMPTY_POSITIONS: ReadonlyMap<string, { x: number; y: number }> = new Map()
const EMPTY_IDS: ReadonlySet<string> = new Set()

/** Release a pointer capture without throwing when the browser already did. */
function releasePointerCapture(element: HTMLElement, pointerId: number): void {
  try {
    if (element.releasePointerCapture === undefined) return
    if (
      element.hasPointerCapture === undefined ||
      element.hasPointerCapture(pointerId)
    ) {
      element.releasePointerCapture(pointerId)
    }
  } catch {
    // The browser releases capture automatically after pointerup/cancel.
  }
}

interface NodePlacement {
  x: number
  y: number
  height: number
}

/**
 * Live node placements from the current user positions. Expanding a
 * preview grows a node, so its bottom socket moves and the nodes below it
 * in the same column are pushed down. Shared by rendering and the drop
 * layout so both always agree, even before React paints the latest move.
 */
function computePlacements(
  graph: FlowGraph,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  expandedNodeIds: ReadonlySet<string>,
): Map<string, NodePlacement> {
  const currentX = (node: FlowGraphNode): number =>
    positions.get(node.id)?.x ?? node.x
  const currentY = (node: FlowGraphNode): number =>
    positions.get(node.id)?.y ?? node.y
  const expanded = graph.nodes.filter(
    (node) => expandedNodeIds.has(node.id) && node.expandedHeight !== undefined,
  )
  const map = new Map<string, NodePlacement>()
  for (const node of graph.nodes) {
    let shift = 0
    for (const grown of expanded) {
      if (grown.id === node.id) continue
      // Only nodes in the same live column and fully below the grown node
      // move; other columns keep their slot.
      if (
        Math.abs(currentX(node) - currentX(grown)) < 1 &&
        currentY(node) >= currentY(grown) + grown.height
      ) {
        shift += (grown.expandedHeight ?? grown.height) - grown.height
      }
    }
    map.set(node.id, {
      x: currentX(node),
      y: currentY(node) + shift,
      height: nodeDisplayHeight(node, expandedNodeIds.has(node.id)),
    })
  }
  return map
}

/**
 * Wire colour identity. Main/final wires use their owning stage accent;
 * joins, branches and group members have dedicated colours so a fan-out
 * is readable at a glance.
 */
const EDGE_ACCENT: Record<FlowEdgeKind, NodeAccentKey | null> = {
  main: null,
  'join-input': 'join',
  cte: 'join',
  compound: 'distinct',
  rejected: 'rejected',
  'group-member': 'group',
  final: 'final',
}

function edgeAccent(edge: FlowGraphEdge): NodeAccentKey {
  return EDGE_ACCENT[edge.kind] ?? stageAccentKey(edge.stage)
}

function isDashedEdge(kind: FlowEdgeKind): boolean {
  return kind === 'rejected'
}

interface LegendChipProps {
  className: string
  label: string
}

function LegendChip({ className, label }: LegendChipProps) {
  return (
    <span className="inline-flex items-center gap-1 text-[9.5px] text-text-muted">
      <span className={`size-2 rounded-full ${className}`} aria-hidden />
      {label}
    </span>
  )
}

interface FlowCanvasProps {
  graph: FlowGraph
  nodeStatuses: Record<string, FlowElementStatus>
  edgeStatuses: Record<string, FlowElementStatus>
  packetEdgeIds: string[]
  selectedNodeId: string | null
  /** While true, the camera keeps the running stage in view. */
  following?: boolean
  /**
   * Block-scoped stage key the user just sought to (`q2:WHERE`), whose
   * operation node is scrolled into view. Null means no focus.
   */
  focusStageKey?: string | null
  onSelectNode: (node: FlowGraphNode) => void
  /** Clear the current selection (tap on empty canvas, Escape). */
  onDeselectNode?: () => void
}

export function FlowCanvas({
  graph,
  nodeStatuses,
  edgeStatuses,
  packetEdgeIds,
  selectedNodeId,
  following = false,
  focusStageKey = null,
  onSelectNode,
  onDeselectNode,
}: FlowCanvasProps) {
  const reducedMotion = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(new Set())
  // Pointer-hovered node, used to emphasize its real data connections
  // without requiring the user to select/inspect it first. Keyed to the
  // graph instance so a new trace drops any stale hover instead of
  // painting a hover path for a pointer that has not moved.
  const [hoverState, setHoverState] = useState<{
    graph: FlowGraph | null
    id: string | null
  }>({ graph: null, id: null })
  const hoveredNodeId = hoverState.graph === graph ? hoverState.id : null
  // Absolute node positions chosen by dragging/settling, keyed to the
  // graph instance so a new trace returns to the deterministic layout.
  const [placementState, setPlacementState] = useState<{
    graph: FlowGraph | null
    positions: ReadonlyMap<string, { x: number; y: number }>
  }>({ graph: null, positions: EMPTY_POSITIONS })
  const placementRef = useRef(placementState)
  const nodePositions =
    placementState.graph === graph ? placementState.positions : EMPTY_POSITIONS
  // Nodes the user has deliberately placed. Collision resolution prefers
  // to move nodes that have not been hand-positioned.
  const [manualState, setManualState] = useState<{
    graph: FlowGraph | null
    ids: ReadonlySet<string>
  }>({ graph: null, ids: EMPTY_IDS })
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const nodeDragRef = useRef<{
    nodeId: string
    pointerId: number
    startX: number
    startY: number
    positionX: number
    positionY: number
    moved: boolean
  } | null>(null)
  const panRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    panX: number
    panY: number
  } | null>(null)
  /**
   * Active touch pointers, keyed by pointer id. Two or more pointers mean
   * a gesture (pinch zoom + two-finger pan) owns the camera until every
   * finger lifts. Kept in a ref so gesture maths never re-renders.
   */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<{
    startDistance: number
    startZoom: number
    /** Graph-space point under the gesture's initial midpoint. */
    anchorX: number
    anchorY: number
  } | null>(null)
  /** A gesture consumed the pointers; remaining fingers must not pan. */
  const gestureEndedRef = useRef(false)
  /** Pointer travel tracked for tap-to-deselect on empty canvas. */
  const panMovedRef = useRef(false)
  // A drag ends with a compatibility `click`; swallow exactly that click
  // so dragging a node never selects or toggles it. The flag is reset on
  // the next pointerdown, so the following intentional click works.
  const suppressClickRef = useRef(false)
  // Mirror of `zoom` for pointer-anchored maths. Reading the previous
  // zoom synchronously keeps repeated wheel ticks exact instead of
  // depending on React's batching.
  const zoomRef = useRef(1)
  /**
   * Which camera the canvas is following. `initial`, `fit` and `top` are
   * automatic and may be re-applied when the viewport resizes; `manual`
   * means the user (or playback following) moved the view, so a resize
   * must not take it over.
   */
  const cameraIntentRef = useRef<'initial' | 'fit' | 'top' | 'manual'>('initial')
  // Stable wrapper so memoized nodes do not re-render when the workspace
  // recreates its selection handler.
  const selectRef = useRef(onSelectNode)
  useEffect(() => {
    selectRef.current = onSelectNode
  }, [onSelectNode])
  const selectNode = useCallback((node: FlowGraphNode) => selectRef.current(node), [])
  const deselectRef = useRef(onDeselectNode)
  useEffect(() => {
    deselectRef.current = onDeselectNode
  }, [onDeselectNode])
  const deselectNode = useCallback(() => deselectRef.current?.(), [])
  const hoverNode = useCallback((nodeId: string | null) => {
    // A node drag keeps its own hovered path stable. Pointer-enter events
    // for nodes passed under the cursor must not swap the inspected route
    // mid-drag.
    if (nodeDragRef.current !== null) return
    setHoverState({ graph, id: nodeId })
  }, [graph])

  const commitPositions = useCallback(
    (positions: ReadonlyMap<string, { x: number; y: number }>) => {
      const next = { graph, positions }
      placementRef.current = next
      setPlacementState(next)
    },
    [graph],
  )

  const moveNode = useCallback(
    (nodeId: string, x: number, y: number) => {
      const current = placementRef.current
      const base = current.graph === graph ? current.positions : EMPTY_POSITIONS
      const next = new Map(base)
      next.set(nodeId, { x, y })
      commitPositions(next)
    },
    [commitPositions, graph],
  )

  const clampZoom = useCallback(
    (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)),
    [],
  )

  /**
   * Live placement. Expanding a preview grows a node, so its bottom
   * socket moves; nodes below it in the same column are pushed down to
   * make room instead of overlapping. Wires are re-routed from the same
   * deterministic socket geometry using these live positions, never
   * re-measured from the DOM.
   */
  const placements = useMemo(
    () => computePlacements(graph, nodePositions, expandedNodeIds),
    [graph, nodePositions, expandedNodeIds],
  )

  // The SVG surface follows the real node extents, so a node can always
  // be dragged or settled outside the builder's original bounds without
  // being clipped. The builder bounds stay as a minimum.
  const nodeBoxes = useMemo(
    () =>
      graph.nodes.map((node) => {
        const placement = placements.get(node.id)
        return {
          x: placement?.x ?? node.x,
          y: placement?.y ?? node.y,
          width: node.width,
          height: placement?.height ?? node.height,
          side: node.kind === 'branch' || node.kind === 'group',
        }
      }),
    [graph.nodes, placements],
  )
  const canvasBounds = useMemo(
    () => measureFlowLayout(nodeBoxes, graph.bounds),
    [graph.bounds, nodeBoxes],
  )

  /**
   * Position the camera.
   *
   * `fit`      — fit and centre every node (including side-column cards).
   * `top`      — fit the full node width and anchor the graph at the top.
   * `initial`  — show the whole graph when it fits at a readable zoom,
   *              otherwise fall back to the top-anchored width fit.
   */
  const applyCamera = useCallback(
    (
      mode: 'initial' | 'fit' | 'top',
      options: { readableFloor?: boolean } = {},
    ) => {
      const container = containerRef.current
      if (container === null) return
      const { clientWidth, clientHeight } = container
      if (clientWidth === 0 || clientHeight === 0) return
      const viewport = {
        width: clientWidth,
        height: clientHeight,
        padding: 30,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        clearance: FLOW_FIT_CLEARANCE,
      }
      // The phone-sized readable floor applies to the first view of a graph
      // only. A later resize still honours the fit contract (everything
      // visible), so resizing never produces an unreadable half-panned view.
      const readableFloor =
        options.readableFloor === true && clientWidth < MOBILE_VIEWPORT_MAX
      const camera =
        mode === 'fit'
          ? fitFlowLayout(nodeBoxes, viewport)
          : mode === 'top'
            ? fitFlowLayoutWidth(nodeBoxes, viewport)
            : initialFlowLayout(nodeBoxes, viewport, {
                minReadableZoom: readableFloor ? MOBILE_INITIAL_MIN_ZOOM : viewport.minZoom,
              })
      if (camera === null) return
      cameraIntentRef.current = mode
      zoomRef.current = camera.zoom
      setZoom(camera.zoom)
      setPan({ x: camera.panX, y: camera.panY })
    },
    [nodeBoxes],
  )

  const fitToScreen = useCallback(() => applyCamera('fit'), [applyCamera])

  // Keep the latest camera function reachable from the resize observer
  // without re-subscribing on every graph or expansion change.
  const applyCameraRef = useRef(applyCamera)
  useEffect(() => {
    applyCameraRef.current = applyCamera
  }, [applyCamera])

  // Fit the graph the first time it is measurable. Keyed to the graph
  // instance, not the live bounds, so dragging, settling, expanding a
  // preview or playback never yanks the camera.
  const fittedGraphRef = useRef<FlowGraph | null>(null)
  useEffect(() => {
    if (fittedGraphRef.current === graph) return
    const container = containerRef.current
    if (container === null || container.clientWidth === 0) return
    fittedGraphRef.current = graph
    applyCamera('initial', { readableFloor: true })
  })

  // A viewport resize keeps automatic cameras accurate without stealing
  // navigation the user (or playback following) performed.
  useEffect(() => {
    const container = containerRef.current
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const intent = cameraIntentRef.current
      if (intent === 'manual') return
      // Resizing into phone width keeps the view legible; a small desktop
      // window still refits to show the whole graph.
      const width = container.clientWidth
      const readableFloor = intent === 'initial' && width < MOBILE_RESIZE_FLOOR_MAX
      applyCameraRef.current(intent, { readableFloor })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Keep the running stage in view during playback. The camera only moves
  // when the active node is outside the visible band, so manual panning
  // inside the band is preserved.
  const activeNodeKey = useMemo(
    () =>
      graph.nodes
        .filter((node) => nodeStatuses[node.id] === 'active')
        .map((node) => node.id)
        .join('|'),
    [graph.nodes, nodeStatuses],
  )
  useEffect(() => {
    if (!following || activeNodeKey === '' || draggingNodeId !== null) return
    const container = containerRef.current
    if (container === null || container.clientHeight === 0) return
    const ids = new Set(activeNodeKey.split('|'))
    const active = graph.nodes.find((node) => ids.has(node.id))
    if (active === undefined) return
    const placement = placements.get(active.id)
    if (placement === undefined) return
    const height = container.clientHeight
    const margin = Math.min(90, height * 0.22)
    setPan((current) => {
      const top = current.y + placement.y * zoom
      const bottom = current.y + (placement.y + placement.height) * zoom
      if (top >= margin && bottom <= height - margin) return current
      // Following the tour counts as intentional camera movement: a resize
      // must not snap the viewport away from the running stage.
      cameraIntentRef.current = 'manual'
      if (top < margin) return { ...current, y: margin - placement.y * zoom }
      return { ...current, y: height - margin - (placement.y + placement.height) * zoom }
    })
  }, [activeNodeKey, draggingNodeId, following, graph.nodes, placements, zoom])

  // When the final result appears, make sure it is on screen once — the
  // tour ends on the produced rows, not on the last operation.
  const finalCompleted = nodeStatuses['final'] === 'completed'
  const finalFocusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!finalCompleted) {
      finalFocusedRef.current = null
      return
    }
    // Never move the camera out from under an active node drag.
    if (draggingNodeId !== null) return
    const key = `${graph.bounds.width}x${graph.bounds.height}`
    if (finalFocusedRef.current === key) return
    const container = containerRef.current
    if (container === null || container.clientHeight === 0) return
    const finalNode = graph.nodes.find((node) => node.id === 'final')
    if (finalNode === undefined) return
    const placement = placements.get(finalNode.id)
    if (placement === undefined) return
    finalFocusedRef.current = key
    const height = container.clientHeight
    setPan((current) => {
      const bottom = current.y + (placement.y + placement.height) * zoom
      if (bottom <= height - 20) return current
      cameraIntentRef.current = 'manual'
      return { ...current, y: height - 20 - (placement.y + placement.height) * zoom }
    })
  }, [draggingNodeId, finalCompleted, graph.nodes, graph.bounds, placements, zoom])

  // Seeking to a stage (clause strip, pipeline, node click) should bring the
  // node that produced it into view. Only the first matching operation node
  // moves the camera, so branch/group nodes stay where they are.
  const focusRef = useRef<{ stage: string; zoom: number } | null>(null)
  useEffect(() => {
    if (focusStageKey === null) {
      focusRef.current = null
      return
    }
    if (focusRef.current?.stage === focusStageKey && focusRef.current.zoom === zoom) return
    const container = containerRef.current
    if (container === null || container.clientHeight === 0) return
    const target = graph.nodes.find(
      (node) => node.stageKey === focusStageKey && node.kind === 'operation',
    )
    if (target === undefined) return
    const placement = placements.get(target.id)
    if (placement === undefined) return
    focusRef.current = { stage: focusStageKey, zoom }
    const height = container.clientHeight
    const margin = Math.min(90, height * 0.22)
    setPan((current) => {
      const top = current.y + placement.y * zoom
      const bottom = current.y + (placement.y + placement.height) * zoom
      if (top >= margin && bottom <= height - margin) return current
      cameraIntentRef.current = 'manual'
      if (top < margin) return { ...current, y: margin - placement.y * zoom }
      return { ...current, y: height - margin - (placement.y + placement.height) * zoom }
    })
  }, [focusStageKey, graph.nodes, placements, zoom])

  const zoomAt = useCallback(
    (factor: number, anchor?: { x: number; y: number }) => {
      const container = containerRef.current
      const previous = zoomRef.current
      const next = clampZoom(previous * factor)
      let point = anchor
      if (point === undefined && container !== null) {
        // Toolbar zoom keeps the visible graph centred instead of
        // dragging it toward the scroll origin.
        const rect = container.getBoundingClientRect()
        point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      }
      zoomRef.current = next
      setZoom(next)
      cameraIntentRef.current = 'manual'
      if (point === undefined || container === null) return
      const rect = container.getBoundingClientRect()
      const cx = point.x - rect.left
      const cy = point.y - rect.top
      setPan((currentPan) => ({
        x: cx - ((cx - currentPan.x) / previous) * next,
        y: cy - ((cy - currentPan.y) / previous) * next,
      }))
    },
    [clampZoom],
  )

  // Wheel/trackpad zoom is registered natively so `preventDefault` is
  // allowed (React's delegated wheel listener is passive, which would let
  // the page scroll while zooming with a trackpad). Plain vertical wheel
  // zooms; pinch (ctrl/meta) also zooms; shift or a dominant horizontal
  // delta pans, which makes two-finger trackpad panning work.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaX === 0 && event.deltaY === 0) return
      // A wheel during a node drag or a pointer pan must not move the
      // camera: both interactions keep a start-space mapping, so zooming
      // mid-gesture would make the node or canvas jump under the pointer.
      if (nodeDragRef.current !== null || panRef.current !== null) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
          x: event.clientX,
          y: event.clientY,
        })
        return
      }
      const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (horizontal) {
        const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
        const dy = event.shiftKey ? 0 : event.deltaY
        cameraIntentRef.current = 'manual'
        setPan((current) => ({ x: current.x - dx, y: current.y - dy }))
        return
      }
      // `deltaMode` 1 is line-based (Firefox mouse wheels); treat every
      // tick as one step, matching the button zoom.
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, {
        x: event.clientX,
        y: event.clientY,
      })
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [zoomAt])

  /** Distance and midpoint of the first two active pointers. */
  const readGesture = useCallback((): {
    distance: number
    midX: number
    midY: number
  } | null => {
    const [first, second] = [...pointersRef.current.values()]
    if (first === undefined || second === undefined) return null
    return {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      midX: (first.x + second.x) / 2,
      midY: (first.y + second.y) / 2,
    }
  }, [])

  /**
   * Begin a two-finger gesture. The graph point under the initial midpoint
   * becomes the anchor, so pinch zoom and two-finger pan both keep the
   * content under the fingers instead of drifting.
   */
  const beginGesture = useCallback(() => {
    const gesture = readGesture()
    const container = containerRef.current
    if (gesture === null || container === null) return
    const rect = container.getBoundingClientRect()
    const current = panRef.current
    const panX = current?.panX ?? pan.x
    const panY = current?.panY ?? pan.y
    const zoom = zoomRef.current
    gestureRef.current = {
      startDistance: Math.max(gesture.distance, 1),
      startZoom: zoom,
      anchorX: (gesture.midX - rect.left - panX) / zoom,
      anchorY: (gesture.midY - rect.top - panY) / zoom,
    }
    // A gesture takes over from any in-flight node drag or pan.
    nodeDragRef.current = null
    panRef.current = null
    panMovedRef.current = true
    gestureEndedRef.current = false
    setPanning(true)
    setDraggingNodeId(null)
  }, [pan.x, pan.y, readGesture])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      // A stale suppression flag must never eat the next deliberate click.
      suppressClickRef.current = false
      // Preview controls are real buttons and must keep their click.
      if (event.target instanceof Element && event.target.closest('button') !== null) {
        return
      }
      if (event.pointerType === 'touch') {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
        event.currentTarget.setPointerCapture?.(event.pointerId)
        if (pointersRef.current.size >= 2) {
          if (gestureRef.current === null) beginGesture()
          return
        }
        gestureEndedRef.current = false
      }
      // A drag that starts on a node moves that node; empty canvas pans.
      const nodeElement =
        event.target instanceof Element ? event.target.closest('.flow-node') : null
      if (nodeElement instanceof HTMLElement) {
        const nodeId = nodeElement.dataset.nodeId
        const node =
          nodeId === undefined
            ? undefined
            : graph.nodes.find((candidate) => candidate.id === nodeId)
        if (node !== undefined) {
          // Stop native text selection / HTML drag before it can start.
          // This is scoped to node drags: canvas panning is handled below.
          event.preventDefault()
          const placement = placementRef.current
          const stored =
            placement.graph === graph ? placement.positions.get(node.id) : undefined
          const position = stored ?? { x: node.x, y: node.y }
          nodeDragRef.current = {
            nodeId: node.id,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            positionX: position.x,
            positionY: position.y,
            moved: false,
          }
          setDraggingNodeId(node.id)
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
        return
      }
      event.preventDefault()
      panMovedRef.current = false
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: pan.x,
        panY: pan.y,
      }
      setPanning(true)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [beginGesture, graph, pan],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }
      // Two-finger gesture: pinch zoom around the moving midpoint while
      // translating by the midpoint delta (two-finger pan).
      if (gestureRef.current !== null) {
        const gesture = gestureRef.current
        const current = readGesture()
        const container = containerRef.current
        if (current === null || container === null) return
        const rect = container.getBoundingClientRect()
        const nextZoom = clampZoom(
          gesture.startZoom * (current.distance / gesture.startDistance),
        )
        cameraIntentRef.current = 'manual'
        zoomRef.current = nextZoom
        setZoom(nextZoom)
        setPan({
          x: current.midX - rect.left - gesture.anchorX * nextZoom,
          y: current.midY - rect.top - gesture.anchorY * nextZoom,
        })
        return
      }
      // Fingers left over after a gesture must not pan or drag.
      if (gestureEndedRef.current && event.pointerType === 'touch') return
      const drag = nodeDragRef.current
      if (drag !== null) {
        if (drag.pointerId !== event.pointerId) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (!drag.moved) {
          // A tiny movement is still a click on the node.
          if (Math.abs(dx) + Math.abs(dy) < CLICK_MOVE_THRESHOLD) return
          drag.moved = true
        }
        // The node follows the pointer exactly. Positions are absolute
        // in graph space while the surface is scaled by `zoom`, so the
        // screen-space delta is converted back into graph space. The
        // layout can grow and the camera never has to move to keep the
        // node under the cursor.
        const scale = zoomRef.current
        moveNode(
          drag.nodeId,
          drag.positionX + dx / scale,
          drag.positionY + dy / scale,
        )
        return
      }
      const state = panRef.current
      if (state === null || state.pointerId !== event.pointerId) return
      const dx = event.clientX - state.startX
      const dy = event.clientY - state.startY
      if (!panMovedRef.current && Math.abs(dx) + Math.abs(dy) >= CLICK_MOVE_THRESHOLD) {
        panMovedRef.current = true
      }
      cameraIntentRef.current = 'manual'
      setPan({
        x: state.panX + dx,
        y: state.panY + dy,
      })
    },
    [clampZoom, moveNode, readGesture],
  )

  /**
   * On release, resolve only the collisions the drop created. The dragged
   * node is pinned, so its chosen position survives; affected neighbours
   * move just enough to restore the minimum spacing.
   */
  const settleNodeDrag = useCallback(
    (draggedId: string) => {
      const current = placementRef.current
      const positions =
        current.graph === graph ? current.positions : EMPTY_POSITIONS
      const manual = manualState.graph === graph ? manualState.ids : EMPTY_IDS
      // Expanded previews change a node's real height, so collision
      // resolution uses the same live placement the canvas renders.
      // Recomputed from the position ref (not the last render) so the
      // final pointer move is always included.
      const livePlacements = computePlacements(graph, positions, expandedNodeIds)
      const offsets = new Map<string, { x: number; y: number }>()
      const boxes = graph.nodes.map((node) => {
        const user = positions.get(node.id) ?? { x: node.x, y: node.y }
        const placement =
          livePlacements.get(node.id) ?? { x: user.x, y: user.y, height: node.height }
        offsets.set(node.id, {
          x: placement.x - user.x,
          y: placement.y - user.y,
        })
        return {
          id: node.id,
          x: placement.x,
          y: placement.y,
          width: node.width,
          height: placement.height,
          column: node.x,
          manual: manual.has(node.id),
        }
      })
      const resolved = resolveFlowLayout(boxes, { pinnedId: draggedId })
      const next = new Map(positions)
      for (const [id, position] of resolved) {
        const offset = offsets.get(id) ?? { x: 0, y: 0 }
        next.set(id, { x: position.x - offset.x, y: position.y - offset.y })
      }
      commitPositions(next)
      setManualState((existing) => {
        const base = existing.graph === graph ? existing.ids : EMPTY_IDS
        if (base.has(draggedId)) {
          return existing.graph === graph ? existing : { graph, ids: base }
        }
        const ids = new Set(base)
        ids.add(draggedId)
        return { graph, ids }
      })
    },
    [commitPositions, expandedNodeIds, graph, manualState],
  )

  const stopInteraction = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const cancelled = event.type === 'pointercancel'
      pointersRef.current.delete(event.pointerId)

      // A pinch/pan gesture owns the camera until every finger lifts. The
      // compatibility click that follows a touch must not select a node.
      if (gestureRef.current !== null) {
        gestureRef.current = null
        gestureEndedRef.current = pointersRef.current.size > 0
        if (!cancelled) suppressClickRef.current = true
        nodeDragRef.current = null
        panRef.current = null
        panMovedRef.current = true
        setPanning(false)
        setDraggingNodeId(null)
        releasePointerCapture(event.currentTarget, event.pointerId)
        return
      }
      // Fingers left over from a finished gesture are inert.
      if (gestureEndedRef.current && event.pointerType === 'touch') {
        if (pointersRef.current.size === 0) gestureEndedRef.current = false
        releasePointerCapture(event.currentTarget, event.pointerId)
        return
      }

      const drag = nodeDragRef.current
      // A cancelled pointer never produces a click, so it must not select.
      if (drag !== null) {
        if (drag.moved) {
          settleNodeDrag(drag.nodeId)
        } else if (!cancelled) {
          // A press that never moved past the threshold is a genuine click.
          // Select here rather than relying on the compatibility `click`
          // event: pointer capture retargets it to the canvas, so the node's
          // own onClick never fires in a real browser.
          const node = graph.nodes.find((candidate) => candidate.id === drag.nodeId)
          if (node !== undefined) selectNode(node)
        }
        // Swallow the compatibility click that follows this interaction so it
        // cannot toggle the selection a second time. The next press clears it.
        if (!cancelled) suppressClickRef.current = true
      } else {
        // A tap (not a drag) on empty canvas clears the inspection, matching
        // the click-a-node-again behaviour on desktop.
        const panned = panRef.current
        if (panned !== null && panned.pointerId === event.pointerId) {
          if (!cancelled && !panMovedRef.current) deselectNode()
          if (!cancelled) suppressClickRef.current = true
        }
      }
      nodeDragRef.current = null
      panRef.current = null
      panMovedRef.current = false
      setPanning(false)
      setDraggingNodeId(null)
      releasePointerCapture(event.currentTarget, event.pointerId)
    },
    [deselectNode, graph.nodes, selectNode, settleNodeDrag],
  )

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const edgeGeometry = useMemo(() => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]))
    const geometry = new Map<string, { curve: Array<{ x: number; y: number }>; label: { x: number; y: number } }>()
    for (const edge of graph.edges) {
      const from = byId.get(edge.from)
      const to = byId.get(edge.to)
      if (from === undefined || to === undefined) continue
      const curve = routeEdgeCurve(from, edge.fromSocket, to, edge.toSocket, {
        from: placements.get(from.id),
        to: placements.get(to.id),
      })
      if (curve.length < 4) continue
      geometry.set(edge.id, { curve, label: curveMidpoint(curve) })
    }
    return geometry
  }, [graph.nodes, graph.edges, placements])

  const visibleEdges = useMemo(
    () =>
      graph.edges.filter(
        (edge) => edgeStatuses[edge.id] !== 'hidden' && edgeGeometry.has(edge.id),
      ),
    [graph.edges, edgeStatuses, edgeGeometry],
  )
  const visibleNodes = useMemo(
    () => graph.nodes.filter((node) => nodeStatuses[node.id] !== 'hidden'),
    [graph.nodes, nodeStatuses],
  )

  // Click selection pins an upstream trace. Hover peeks at another node's
  // upstream route and always wins while the pointer is inside a node;
  // leaving restores the pinned trace, or the full pipeline when nothing
  // is selected. Both traversals are memoized on graph + id so dragging,
  // panning and animation frames never re-walk the graph.
  const selectionPath = useMemo(
    () => traceUpstreamPath(graph, selectedNodeId),
    [graph, selectedNodeId],
  )
  const hoverPath = useMemo(
    () => traceUpstreamPath(graph, hoveredNodeId),
    [graph, hoveredNodeId],
  )
  // A selection or hover can outlive a rewind that hides its node. Keep
  // the state, but only trace while the node is actually visible.
  const selectionActive =
    selectedNodeId !== null &&
    selectionPath.hasSelection &&
    nodeStatuses[selectedNodeId] !== 'hidden'
  const hoverActive =
    hoveredNodeId !== null &&
    hoverPath.hasSelection &&
    nodeStatuses[hoveredNodeId] !== 'hidden'
  const traceMode: 'hover' | 'selection' | null = hoverActive
    ? 'hover'
    : selectionActive
      ? 'selection'
      : null
  const tracePath =
    traceMode === 'hover' ? hoverPath : traceMode === 'selection' ? selectionPath : null
  const traceEdgeIds = tracePath?.edgeIds ?? null
  const traceNodeIds = tracePath?.nodeIds ?? null
  const traceTargetId =
    traceMode === 'hover' ? hoveredNodeId : traceMode === 'selection' ? selectedNodeId : null

  const packetEdgeIdSet = useMemo(() => new Set(packetEdgeIds), [packetEdgeIds])

  // Default mode keeps every connection that has already carried data
  // alive. Pending edges stay visible but do not animate ahead of the
  // simulator, so the pulse always follows playback events.
  const pipelineEdgeIds = useMemo(() => {
    const ids = new Set<string>()
    for (const edge of visibleEdges) {
      const status = edgeStatuses[edge.id]
      if (status === 'completed' || status === 'active') ids.add(edge.id)
    }
    return ids
  }, [visibleEdges, edgeStatuses])

  /** Draw traced edges last so they sit above dimmed ones. */
  const orderedEdges = useMemo(() => {
    if (traceEdgeIds === null) return visibleEdges
    return [...visibleEdges].sort((a, b) => {
      const aTraced = traceEdgeIds.has(a.id) ? 1 : 0
      const bTraced = traceEdgeIds.has(b.id) ? 1 : 0
      return aTraced - bTraced
    })
  }, [visibleEdges, traceEdgeIds])

  // One packet stream per edge.
  // - Hover: strictly the upstream route; downstream wires stay visible
  //   but carry no particles.
  // - Selection: the pinned route plus live playback streams (dimmed) so
  //   the existing selection behaviour is preserved.
  // - Default: every completed/active connection animates.
  const packetGroups = useMemo(() => {
    const groups: Array<{ edge: FlowGraphEdge; mode: 'hover' | 'selection' | 'playback' }> =
      []
    if (traceMode === 'hover') {
      if (traceEdgeIds === null) return groups
      for (const edge of orderedEdges) {
        if (traceEdgeIds.has(edge.id)) groups.push({ edge, mode: 'hover' })
      }
      return groups
    }
    if (traceMode === 'selection') {
      const ids = new Set<string>()
      for (const id of traceEdgeIds ?? []) ids.add(id)
      for (const id of packetEdgeIdSet) ids.add(id)
      for (const edge of orderedEdges) {
        if (!ids.has(edge.id)) continue
        groups.push({
          edge,
          mode: traceEdgeIds?.has(edge.id) === true ? 'selection' : 'playback',
        })
      }
      return groups
    }
    for (const edge of orderedEdges) {
      if (pipelineEdgeIds.has(edge.id)) groups.push({ edge, mode: 'playback' })
    }
    return groups
  }, [orderedEdges, packetEdgeIdSet, pipelineEdgeIds, traceEdgeIds, traceMode])

  // Small per-edge phase offsets keep a traced stream from moving in
  // lockstep; the ordering is nearest-to-target first, so the result
  // reads as a continuous pulse rather than a single flashing line.
  const tracePacketPhase = useMemo(() => {
    const phases = new Map<string, number>()
    if (tracePath === null) return phases
    tracePath.orderedEdgeIds.forEach((edgeId, index) => {
      phases.set(edgeId, index * 0.16)
    })
    return phases
  }, [tracePath])

  const edgeVisual = (edge: FlowGraphEdge, status: FlowElementStatus | undefined) => {
    const active = status === 'active'
    const completed = status === 'completed'
    const onTrace = traceEdgeIds?.has(edge.id) ?? false
    const dimmed = traceEdgeIds !== null && !onTrace
    const accent = edgeAccent(edge)
    // Pending wires must still read as connections. `--border-strong` is a
    // hairline divider token and disappears against the canvas background;
    // every wire uses the dedicated, high-contrast `--flow-wire` token
    // instead, with completed/active stages layered on their accent.
    const color = active || completed ? accentColor(accent) : 'var(--flow-wire)'
    const baseWidth = active ? 2.6 : completed ? 2 : 1.7
    return {
      accent,
      stroke: onTrace ? 'var(--accent)' : color,
      // The traced route is a little heavier than the same edge's normal
      // state, so the path reads as one continuous electrical trace.
      strokeWidth: onTrace ? baseWidth + 0.3 : baseWidth,
      opacity: dimmed
        ? 0.24
        : onTrace
          ? 1
          : active
            ? 1
            : completed
              ? 0.92
              : 0.72,
      strokeDasharray: isDashedEdge(edge.kind) ? '5 4' : undefined,
      markerEnd: onTrace
        ? 'url(#flow-arrow-selected)'
        : active || completed
          ? `url(#flow-arrow-${accent})`
          : 'url(#flow-arrow-idle)',
      dimmed,
      active,
      onTrace,
      flowing: packetEdgeIdSet.has(edge.id),
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Canvas toolbar: legend, interaction hint and camera controls are
          kept out of the graph area so they never cover a node. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border/70 bg-surface px-3 py-1.5">
        <LegendChip className="bg-success" label="completed" />
        <LegendChip className="bg-accent" label="active" />
        <LegendChip className="bg-border-strong" label="pending" />
        <LegendChip className="bg-danger" label="rejected" />
        <LegendChip className="bg-purple" label="groups" />
        <span className="hidden items-center gap-2 border-l border-border pl-2.5 sm:flex">
          <span className="inline-flex items-center gap-1 text-[9.5px] text-text-muted">
            <span className="flow-legend-socket" data-kind="data" aria-hidden />
            data
          </span>
          <span className="inline-flex items-center gap-1 text-[9.5px] text-text-muted">
            <span className="flow-legend-socket" data-kind="branch" aria-hidden />
            branch
          </span>
        </span>
        <span className="ml-auto hidden text-[10px] text-text-muted lg:inline">
          Drag nodes · drag canvas to pan · scroll to zoom · shift+scroll to pan
        </span>
        <div className="ml-auto flex items-center gap-1 lg:ml-2">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => zoomAt(1 / ZOOM_STEP)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:min-h-0 lg:min-w-0"
          >
            <Minus className="size-3.5" aria-hidden />
          </button>
          <span className="w-9 text-center text-[10px] tabular-nums text-text-muted">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => zoomAt(ZOOM_STEP)}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:min-h-0 lg:min-w-0"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <button
            type="button"
            aria-label="Fit to screen"
            title="Fit to screen"
            onClick={fitToScreen}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:min-h-0 lg:min-w-0"
          >
            <Maximize2 className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Reset view"
            title="Reset view"
            onClick={() => applyCamera('top')}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none lg:min-h-0 lg:min-w-0"
          >
            <Crosshair className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`flow-canvas relative min-h-0 w-full flex-1 touch-none overflow-hidden bg-bg ${
          panning || draggingNodeId !== null
            ? 'cursor-grabbing select-none'
            : 'cursor-grab'
        } ${panning ? 'flow-canvas-panning' : ''} ${
          draggingNodeId !== null ? 'flow-canvas-node-dragging' : ''
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopInteraction}
        onPointerCancel={stopInteraction}
        onClickCapture={handleClickCapture}
        onDragStart={(event) => event.preventDefault()}
        role="application"
        aria-label="Animated SQL data-flow canvas"
        data-selected-node={selectedNodeId ?? undefined}
        data-hovered-node={hoverActive && hoveredNodeId !== null ? hoveredNodeId : undefined}
        data-trace-mode={traceMode ?? undefined}
        style={{
          backgroundSize: `${Math.max(12, 24 * zoom)}px ${Math.max(12, 24 * zoom)}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      >
        <div
          className="absolute origin-top-left"
          style={{
            width: canvasBounds.width,
            height: canvasBounds.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0 z-0 overflow-visible"
            width={canvasBounds.width}
            height={canvasBounds.height}
            aria-hidden
          >
            <defs>
              {NODE_ACCENT_KEYS.map((key) => (
                <marker
                  key={key}
                  id={`flow-arrow-${key}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={accentColor(key)} />
                </marker>
              ))}
              <marker
                id="flow-arrow-idle"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--flow-wire)" />
              </marker>
              {/* Selection trace: same geometry as the operation markers,
                  but in the selection colour so the destination is
                  unmistakable at the end of the animated path. */}
              <marker
                id="flow-arrow-selected"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
              </marker>
              <filter id="flow-packet-glow" x="-120%" y="-120%" width="340%" height="340%">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {orderedEdges.map((edge) => {
              const status = edgeStatuses[edge.id]
              const visual = edgeVisual(edge, status)
              const geometry = edgeGeometry.get(edge.id)
              if (geometry === undefined) return null
              const d = curvePath(geometry.curve)
              const labelPoint = geometry.label
              return (
                <g
                  key={edge.id}
                  className="flow-edge"
                  data-edge-id={edge.id}
                  data-from={edge.from}
                  data-to={edge.to}
                  data-kind={edge.kind}
                  data-status={status}
                  data-selected-path={
                    visual.onTrace && traceMode === 'selection' ? 'true' : undefined
                  }
                  data-hover-path={
                    visual.onTrace && traceMode === 'hover' ? 'true' : undefined
                  }
                >
                  {/* Soft halo under an active or traced wire so data
                      movement stands out without thickening the arrow. */}
                  {(visual.active || visual.flowing || visual.onTrace) && (
                    <path
                      d={d}
                      fill="none"
                      stroke={visual.onTrace ? 'var(--accent)' : accentColor(visual.accent)}
                      strokeWidth={visual.strokeWidth + 4.5}
                      strokeLinecap="round"
                      opacity={visual.onTrace ? 0.16 : visual.dimmed ? 0.05 : 0.12}
                      vectorEffect="non-scaling-stroke"
                      aria-hidden
                    />
                  )}
                  <path
                    id={`edge-path-${edge.id}`}
                    d={d}
                    fill="none"
                    stroke={visual.stroke}
                    strokeWidth={visual.strokeWidth}
                    strokeDasharray={visual.strokeDasharray}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    opacity={visual.opacity}
                    markerEnd={visual.markerEnd}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* Marching overlay: readable direction along the active route.
                      Traced edges use their own selection packets for
                      direction, so the stage-coloured march is suppressed
                      there to avoid two competing animations/colours. */}
                  {visual.flowing && !visual.onTrace && !reducedMotion && (
                    <path
                      d={d}
                      fill="none"
                      stroke={accentColor(visual.accent)}
                      strokeWidth={visual.strokeWidth + 1.4}
                      strokeDasharray="3 13"
                      strokeLinecap="round"
                      opacity={visual.dimmed ? 0.16 : 0.55}
                      className="flow-edge-active"
                      vectorEffect="non-scaling-stroke"
                      aria-hidden
                    />
                  )}
                  {edge.label !== undefined && (
                    <g opacity={visual.dimmed ? 0.3 : 1}>
                      <rect
                        x={labelPoint.x - (edge.label.length * 2.6 + 6)}
                        y={labelPoint.y - 8}
                        width={edge.label.length * 5.2 + 12}
                        height={14}
                        rx={4}
                        fill="var(--surface)"
                        stroke="var(--border)"
                        strokeWidth={0.75}
                      />
                      <text
                        x={labelPoint.x}
                        y={labelPoint.y + 2}
                        textAnchor="middle"
                        fontSize={8}
                        fill={edge.kind === 'rejected' ? 'var(--danger)' : 'var(--text-muted)'}
                      >
                        {edge.label}
                      </text>
                    </g>
                  )}
                </g>
              )
            })}
            {/* Data packets: one layer above every wire, still behind the
                node surfaces. Each packet follows the real edge path, so
                the selected upstream trace and live playback always move
                in the true data-flow direction. */}
            {!reducedMotion && packetGroups.length > 0 && (
              <g className="flow-packets" aria-hidden>
                {packetGroups.map(({ edge, mode }) => {
                  const accent = edgeAccent(edge)
                  const tracePacket = mode === 'hover' || mode === 'selection'
                  const duration = mode === 'hover' ? 1.15 : tracePacket ? 1.25 : 1.6
                  const phase = tracePacket ? (tracePacketPhase.get(edge.id) ?? 0) : 0
                  return (
                    <g
                      key={edge.id}
                      data-edge-id={edge.id}
                      data-mode={mode}
                      // Keep playback visible during a pinned selection
                      // without competing with the brighter trace packets.
                      opacity={traceMode === 'selection' && !tracePacket ? 0.65 : 1}
                    >
                      {Array.from({ length: PACKETS_PER_EDGE }, (_, packetIndex) => (
                        <circle
                          key={packetIndex}
                          className="flow-packet"
                          r={
                            tracePacket
                              ? packetIndex === 0
                                ? 4.5
                                : 3
                              : packetIndex === 0
                                ? 4.2
                                : 2.8
                          }
                          fill={tracePacket ? 'var(--accent)' : accentColor(accent)}
                          opacity={
                            tracePacket
                              ? packetIndex === 0
                                ? 1
                                : 0.6
                              : packetIndex === 0
                                ? 0.95
                                : 0.55
                          }
                          filter={
                            packetIndex === 0 ? 'url(#flow-packet-glow)' : undefined
                          }
                        >
                          <animateMotion
                            dur={`${duration}s`}
                            begin={`${-(phase + packetIndex * (duration / PACKETS_PER_EDGE))}s`}
                            repeatCount="indefinite"
                          >
                            <mpath href={`#edge-path-${edge.id}`} />
                          </animateMotion>
                        </circle>
                      ))}
                    </g>
                  )
                })}
              </g>
            )}
          </svg>

          {visibleNodes.map((node) => (
            <FlowNodeView
              key={node.id}
              node={node}
              status={nodeStatuses[node.id] ?? 'pending'}
              selected={selectedNodeId === node.id}
              hovered={traceMode === 'hover' && hoveredNodeId === node.id}
              upstream={
                traceNodeIds !== null &&
                traceNodeIds.has(node.id) &&
                node.id !== traceTargetId
              }
              expanded={expandedNodeIds.has(node.id)}
              dragging={draggingNodeId === node.id}
              offsetX={(placements.get(node.id)?.x ?? node.x) - node.x}
              offsetY={(placements.get(node.id)?.y ?? node.y) - node.y}
              onSelect={selectNode}
              onHover={hoverNode}
              onToggleExpand={toggleExpand}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
