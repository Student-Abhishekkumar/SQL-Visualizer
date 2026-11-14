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
import { FlowNodeView } from './FlowNodeView'

/**
 * Interactive animated data-flow canvas: HTML nodes on a pan/zoom
 * surface, SVG edges with arrowheads and animated data packets for the
 * currently active connections. Packets are visual indicators of data
 * movement along a real dependency — they never pretend to be a
 * specific database row.
 */

const MIN_ZOOM = 0.22
const MAX_ZOOM = 2.2
const ZOOM_STEP = 1.2
const PACKETS_PER_EDGE = 3

/** Rounded elbow polyline → SVG path string. */
function edgePath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return ''
  const first = points[0]
  if (first === undefined) return ''
  const radius = 12
  const parts = [`M ${first.x} ${first.y}`]
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]
    const current = points[i]
    if (current === undefined || previous === undefined) continue
    const isLast = i === points.length - 1
    if (isLast) {
      parts.push(`L ${current.x} ${current.y}`)
      continue
    }
    const dx = current.x - previous.x
    const dy = current.y - previous.y
    const length = Math.hypot(dx, dy)
    if (length === 0) continue
    const cutoff = Math.min(radius, length / 2)
    const cutX = previous.x + (dx / length) * cutoff
    const cutY = previous.y + (dy / length) * cutoff
    const next = points[i + 1]
    if (next === undefined) {
      parts.push(`L ${current.x} ${current.y}`)
      continue
    }
    const ndx = next.x - current.x
    const ndy = next.y - current.y
    const nLength = Math.hypot(ndx, ndy)
    if (nLength === 0) {
      parts.push(`L ${current.x} ${current.y}`)
      continue
    }
    const nCutoff = Math.min(radius, nLength / 2)
    parts.push(
      `L ${cutX} ${cutY} Q ${current.x} ${current.y} ${current.x + (ndx / nLength) * nCutoff} ${
        current.y + (ndy / nLength) * nCutoff
      }`,
    )
  }
  return parts.join(' ')
}

const EDGE_COLORS: Record<FlowEdgeKind, string> = {
  main: 'var(--accent)',
  'join-input': 'var(--purple)',
  rejected: 'var(--danger)',
  'group-member': 'var(--purple)',
  final: 'var(--accent)',
}

/** Arrowhead marker matching each edge family's colour. */
const EDGE_MARKERS: Record<FlowEdgeKind, string> = {
  main: 'flow-arrow-accent',
  'join-input': 'flow-arrow-purple',
  rejected: 'flow-arrow-danger',
  'group-member': 'flow-arrow-purple',
  final: 'flow-arrow-accent',
}

const PACKET_COLORS: Record<FlowEdgeKind, string> = {
  main: 'var(--accent)',
  'join-input': 'var(--purple)',
  rejected: 'var(--danger)',
  'group-member': 'var(--purple)',
  final: 'var(--accent)',
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
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(new Set())
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null)

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
    const key = `${graph.bounds.width}x${graph.bounds.height}x${zoom}`
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
      setZoom((current) => {
        const next = clampZoom(current * factor)
        if (anchor !== undefined && container !== null) {
          const rect = container.getBoundingClientRect()
          const cx = anchor.x - rect.left
          const cy = anchor.y - rect.top
          setPan((currentPan) => ({
            x: cx - ((cx - currentPan.x) / current) * next,
            y: cy - ((cy - currentPan.y) / current) * next,
          }))
        }
        return next
      })
    },
    [clampZoom],
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: event.clientX, y: event.clientY })
    },
    [zoomAt],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return
      // Node clicks inspect them; only empty-canvas drags pan.
      if (event.target instanceof Element && event.target.closest('.flow-node, button') !== null) {
        return
      }
      panRef.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y }
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

  const handlePointerUp = useCallback(() => {
    panRef.current = null
  }, [])

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => edgeStatuses[edge.id] !== 'hidden' && edge.points.length >= 2),
    [graph.edges, edgeStatuses],
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
    const color = active || completed ? EDGE_COLORS[edge.kind] : 'var(--border-strong)'
    return {
      stroke: emphasized ? 'var(--accent)' : color,
      strokeWidth: active ? 2.5 : completed ? 1.8 : 1.4,
      opacity: dimmed ? 0.16 : active ? 1 : completed ? 0.8 : 0.42,
      strokeDasharray: isDashedEdge(edge.kind) ? '5 4' : undefined,
      markerEnd:
        active || completed
          ? `url(#${EDGE_MARKERS[edge.kind]})`
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
        className="relative min-h-0 w-full flex-1 overflow-hidden bg-bg"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
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
            {(
              [
                ['flow-arrow-accent', 'var(--accent)'],
                ['flow-arrow-purple', 'var(--purple)'],
                ['flow-arrow-danger', 'var(--danger)'],
                ['flow-arrow-idle', 'var(--border-strong)'],
              ] as const
            ).map(([id, fill]) => (
              <marker
                key={id}
                id={id}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} />
              </marker>
            ))}
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
            const d = edgePath(edge.points)
            const labelPoint = edge.labelPoint
            return (
              <g key={edge.id}>
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
                    stroke={PACKET_COLORS[edge.kind]}
                    strokeWidth={visual.strokeWidth + 1.4}
                    strokeDasharray="3 13"
                    strokeLinecap="round"
                    opacity={visual.dimmed ? 0.12 : 0.5}
                    className="flow-edge-active"
                    aria-hidden
                  />
                )}
                {edge.label !== undefined && labelPoint !== undefined && (
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
                      fill={PACKET_COLORS[edge.kind]}
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
            onSelect={onSelectNode}
            onToggleExpand={toggleExpand}
          />
        ))}
      </div>
      </div>
    </div>
  )
}
