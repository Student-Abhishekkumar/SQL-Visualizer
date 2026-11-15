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
import type { VisualizedStage } from '../../../types/visualization'
import {
  curveMidpoint,
  curvePath,
  nodeDisplayHeight,
  routeEdgeCurve,
} from '../../../services/visualization/flowGeometry'
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
const PACKETS_PER_EDGE = 3

/**
 * Wire colour identity. Main/final wires use their owning stage accent;
 * joins, branches and group members have dedicated colours so a fan-out
 * is readable at a glance.
 */
const EDGE_ACCENT: Record<FlowEdgeKind, NodeAccentKey | null> = {
  main: null,
  'join-input': 'join',
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
  /** Stage the user just sought to; its node is scrolled into view. */
  focusStage?: VisualizedStage | null
  onSelectNode: (node: FlowGraphNode) => void
}

export function FlowCanvas({
  graph,
  nodeStatuses,
  edgeStatuses,
  packetEdgeIds,
  selectedNodeId,
  following = false,
  focusStage = null,
  onSelectNode,
}: FlowCanvasProps) {
  const reducedMotion = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(new Set())
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)
  // Mirror of `zoom` for pointer-anchored maths. Reading the previous
  // zoom synchronously keeps repeated wheel ticks exact instead of
  // depending on React's batching.
  const zoomRef = useRef(1)
  // Stable wrapper so memoized nodes do not re-render when the workspace
  // recreates its selection handler.
  const selectRef = useRef(onSelectNode)
  useEffect(() => {
    selectRef.current = onSelectNode
  }, [onSelectNode])
  const selectNode = useCallback((node: FlowGraphNode) => selectRef.current(node), [])

  const clampZoom = useCallback(
    (value: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)),
    [],
  )

  /** Position the camera: full fit, or width-fit anchored at the top. */
  const applyCamera = useCallback(
    (mode: 'fit' | 'top') => {
      const container = containerRef.current
      if (container === null) return
      const { clientWidth, clientHeight } = container
      if (clientWidth === 0 || clientHeight === 0) return
      const padding = 30
      const fitScale = Math.min(
        (clientWidth - padding * 2) / graph.bounds.width,
        (clientHeight - padding * 2) / graph.bounds.height,
      )
      const widthScale = (clientWidth - padding * 2) / Math.max(graph.bounds.flowWidth, 1)
      const nextZoom = clampZoom(mode === 'fit' ? fitScale : Math.min(widthScale, 1))
      const contentWidth = mode === 'fit' ? graph.bounds.width : graph.bounds.flowWidth
      zoomRef.current = nextZoom
      setZoom(nextZoom)
      setPan({
        x: Math.max((clientWidth - contentWidth * nextZoom) / 2, 8),
        y:
          mode === 'fit'
            ? Math.max((clientHeight - graph.bounds.height * nextZoom) / 2, 8)
            : 12,
      })
    },
    [graph.bounds, clampZoom],
  )

  const fitToScreen = useCallback(() => applyCamera('fit'), [applyCamera])

  // Fit the graph the first time it is measurable (width-fit so labels
  // stay readable), and again when a new trace produces different bounds.
  const fittedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const key = `${graph.bounds.width}x${graph.bounds.height}x${graph.bounds.flowWidth}`
    if (fittedKeyRef.current === key) return
    const container = containerRef.current
    if (container === null || container.clientWidth === 0) return
    fittedKeyRef.current = key
    applyCamera('top')
  })

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
    if (!following || activeNodeKey === '') return
    const container = containerRef.current
    if (container === null || container.clientHeight === 0) return
    const ids = new Set(activeNodeKey.split('|'))
    const active = graph.nodes.find((node) => ids.has(node.id))
    if (active === undefined) return
    const height = container.clientHeight
    const margin = Math.min(90, height * 0.22)
    setPan((current) => {
      const top = current.y + active.y * zoom
      const bottom = current.y + (active.y + active.height) * zoom
      if (top >= margin && bottom <= height - margin) return current
      if (top < margin) return { ...current, y: margin - active.y * zoom }
      return { ...current, y: height - margin - (active.y + active.height) * zoom }
    })
  }, [activeNodeKey, following, graph.nodes, zoom])

  // When the final result appears, make sure it is on screen once — the
  // tour ends on the produced rows, not on the last operation.
  const finalCompleted = nodeStatuses['final'] === 'completed'
  const finalFocusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!finalCompleted) {
      finalFocusedRef.current = null
      return
    }
    const key = `${graph.bounds.width}x${graph.bounds.height}`
    if (finalFocusedRef.current === key) return
    const container = containerRef.current
    if (container === null || container.clientHeight === 0) return
    const finalNode = graph.nodes.find((node) => node.id === 'final')
    if (finalNode === undefined) return
    finalFocusedRef.current = key
    const height = container.clientHeight
    setPan((current) => {
      const bottom = current.y + (finalNode.y + finalNode.height) * zoom
      if (bottom <= height - 20) return current
      return { ...current, y: height - 20 - (finalNode.y + finalNode.height) * zoom }
    })
  }, [finalCompleted, graph.nodes, graph.bounds, zoom])

  // Seeking to a stage (clause strip, pipeline, node click) should bring the
  // node that produced it into view. Only the first matching operation node
  // moves the camera, so branch/group nodes stay where they are.
  const focusRef = useRef<{ stage: VisualizedStage; zoom: number } | null>(null)
  useEffect(() => {
    if (focusStage === null) {
      focusRef.current = null
      return
    }
    if (focusRef.current?.stage === focusStage && focusRef.current.zoom === zoom) return
    const container = containerRef.current
    if (container === null || container.clientHeight === 0) return
    const target = graph.nodes.find(
      (node) => node.stage === focusStage && node.kind === 'operation',
    )
    if (target === undefined) return
    focusRef.current = { stage: focusStage, zoom }
    const height = container.clientHeight
    const margin = Math.min(90, height * 0.22)
    setPan((current) => {
      const top = current.y + target.y * zoom
      const bottom = current.y + (target.y + target.height) * zoom
      if (top >= margin && bottom <= height - margin) return current
      if (top < margin) return { ...current, y: margin - target.y * zoom }
      return { ...current, y: height - margin - (target.y + target.height) * zoom }
    })
  }, [focusStage, graph.nodes, zoom])

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
  // the page scroll while zooming with a trackpad).
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      event.preventDefault()
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

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return
      // Node clicks inspect them; only empty-canvas drags pan.
      if (event.target instanceof Element && event.target.closest('.flow-node, button') !== null) {
        return
      }
      panRef.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }
      setPanning(true)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    },
    [pan],
  )

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const state = panRef.current
    if (state === null) return
    setPan({
      x: state.panX + (event.clientX - state.startX),
      y: state.panY + (event.clientY - state.startY),
    })
  }, [])

  const stopPanning = useCallback(() => {
    panRef.current = null
    setPanning(false)
  }, [])

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  /**
   * Live placement. Expanding a preview grows a node, so its bottom
   * socket moves; nodes below it are pushed down to make room instead of
   * overlapping. Wires are re-routed from the same deterministic socket
   * geometry using these live positions, never re-measured from the DOM.
   */
  const placements = useMemo(() => {
    const expanded = graph.nodes.filter(
      (node) => expandedNodeIds.has(node.id) && node.expandedHeight !== undefined,
    )
    const map = new Map<string, { y: number; height: number }>()
    for (const node of graph.nodes) {
      let shift = 0
      for (const grown of expanded) {
        if (grown.id === node.id) continue
        // Only nodes in the same column and fully below the grown node
        // move; other columns keep their slot, so a growing preview never
        // shifts an unrelated pipeline branch.
        if (node.x === grown.x && node.y >= grown.y + grown.height) {
          shift += (grown.expandedHeight ?? grown.height) - grown.height
        }
      }
      map.set(node.id, {
        y: node.y + shift,
        height: nodeDisplayHeight(node, expandedNodeIds.has(node.id)),
      })
    }
    return map
  }, [graph.nodes, expandedNodeIds])

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

  // Edges connected to the selected node are emphasized; everything
  // else is dimmed so the selected path is easy to follow.
  const connectedEdgeIds = useMemo(() => {
    if (selectedNodeId === null) return null
    return new Set(
      graph.edges
        .filter((edge) => edge.from === selectedNodeId || edge.to === selectedNodeId)
        .map((edge) => edge.id),
    )
  }, [graph.edges, selectedNodeId])

  /** Draw emphasized edges last so they sit above dimmed ones. */
  const orderedEdges = useMemo(() => {
    if (connectedEdgeIds === null) return visibleEdges
    return [...visibleEdges].sort((a, b) => {
      const aConnected = connectedEdgeIds.has(a.id) ? 1 : 0
      const bConnected = connectedEdgeIds.has(b.id) ? 1 : 0
      return aConnected - bConnected
    })
  }, [visibleEdges, connectedEdgeIds])

  const edgeVisual = (edge: FlowGraphEdge, status: FlowElementStatus | undefined) => {
    const active = status === 'active'
    const completed = status === 'completed'
    const emphasized = connectedEdgeIds?.has(edge.id) ?? false
    const dimmed = connectedEdgeIds !== null && !emphasized
    const accent = edgeAccent(edge)
    const color = active || completed ? accentColor(accent) : 'var(--border-strong)'
    return {
      accent,
      stroke: emphasized ? 'var(--accent)' : color,
      strokeWidth: active ? 2.5 : completed ? 1.8 : 1.4,
      opacity: dimmed ? 0.16 : active ? 1 : completed ? 0.8 : 0.42,
      strokeDasharray: isDashedEdge(edge.kind) ? '5 4' : undefined,
      markerEnd:
        active || completed
          ? `url(#flow-arrow-${accent})`
          : 'url(#flow-arrow-idle)',
      dimmed,
      active,
      flowing: packetEdgeIds.includes(edge.id),
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
          Drag to pan · scroll to zoom · click a node to inspect
        </span>
        <div className="ml-auto flex items-center gap-1 lg:ml-2">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => zoomAt(1 / ZOOM_STEP)}
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
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
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <button
            type="button"
            aria-label="Fit to screen"
            title="Fit to screen"
            onClick={fitToScreen}
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Maximize2 className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Reset view"
            title="Reset view"
            onClick={() => applyCamera('top')}
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Crosshair className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`relative min-h-0 w-full flex-1 touch-none overflow-hidden bg-bg ${
          panning ? 'cursor-grabbing select-none' : 'cursor-grab'
        } ${panning ? 'flow-canvas-panning' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopPanning}
        onPointerCancel={stopPanning}
        role="application"
        aria-label="Animated SQL data-flow canvas"
      >
        <div
          className="absolute origin-top-left"
          style={{
            width: graph.bounds.width,
            height: graph.bounds.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={graph.bounds.width}
            height={graph.bounds.height}
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
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
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
                  data-kind={edge.kind}
                  data-status={status}
                >
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
                  />
                  {/* Marching overlay: readable direction along the active route. */}
                  {visual.flowing && !reducedMotion && (
                    <path
                      d={d}
                      fill="none"
                      stroke={accentColor(visual.accent)}
                      strokeWidth={visual.strokeWidth + 1.4}
                      strokeDasharray="3 13"
                      strokeLinecap="round"
                      opacity={visual.dimmed ? 0.12 : 0.5}
                      className="flow-edge-active"
                      aria-hidden
                    />
                  )}
                  {edge.label !== undefined && (
                    <g opacity={visual.dimmed ? 0.2 : 1}>
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
                  {visual.flowing &&
                    !reducedMotion &&
                    Array.from({ length: PACKETS_PER_EDGE }, (_, packetIndex) => (
                      <circle
                        key={packetIndex}
                        r={packetIndex === 0 ? 4 : 2.6}
                        fill={accentColor(visual.accent)}
                        opacity={packetIndex === 0 ? 0.95 : 0.45}
                        filter={packetIndex === 0 ? 'url(#flow-packet-glow)' : undefined}
                      >
                        <animateMotion
                          dur="1.6s"
                          begin={`${-packetIndex * (1.6 / PACKETS_PER_EDGE)}s`}
                          repeatCount="indefinite"
                        >
                          <mpath href={`#edge-path-${edge.id}`} />
                        </animateMotion>
                      </circle>
                    ))}
                </g>
              )
            })}
          </svg>

          {visibleNodes.map((node) => (
            <FlowNodeView
              key={node.id}
              node={node}
              status={nodeStatuses[node.id] ?? 'pending'}
              selected={selectedNodeId === node.id}
              expanded={expandedNodeIds.has(node.id)}
              offsetY={(placements.get(node.id)?.y ?? node.y) - node.y}
              onSelect={selectNode}
              onToggleExpand={toggleExpand}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
