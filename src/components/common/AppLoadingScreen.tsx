import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  Boxes,
  Check,
  Database,
  Filter,
  FilterX,
  GitMerge,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'
import {
  buildGraph,
  pickLoaderMode,
  type LoaderAccent,
  type LoaderGraph,
  type LoaderNode,
} from './canvasLoaderLayout'

interface AppLoadingScreenProps {
  status: 'uninitialized' | 'initializing'
  /** When true, the composition plays a short camera push-out so the real
   *  workspace appears to grow out of the canvas. */
  exiting?: boolean
}

const MESSAGES = {
  uninitialized: 'Preparing your local workspace…',
  initializing: 'Starting the SQLite engine…',
} as const

const ACCENT_ICONS: Record<LoaderAccent, LucideIcon> = {
  source: Database,
  where: Filter,
  join: GitMerge,
  group: Boxes,
  having: SlidersHorizontal,
  select: Scissors,
  final: Sparkles,
  rejected: FilterX,
}

function useViewport() {
  const [size, setSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }))
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

function socketsFor(graph: LoaderGraph, id: string) {
  return graph.sockets[id] ?? []
}

function LoaderNodeCard({ node, graph }: { node: LoaderNode; graph: LoaderGraph }) {
  const Icon = ACCENT_ICONS[node.accent]
  const style = {
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    '--cl-delay': `${node.delay}s`,
    '--cl-done': `${node.doneDelay}s`,
  } as CSSProperties

  return (
    <div
      className="cl-node"
      data-accent={node.accent}
      data-kind={node.kind}
      data-dashed={node.dashed === true ? 'true' : undefined}
      data-focal={node.focal === true ? 'true' : undefined}
      style={style}
    >
      <span className="cl-node__rail" aria-hidden="true" />
      <div className="cl-node__header">
        <Icon className="cl-node__icon" aria-hidden="true" />
        <span className="cl-node__title">{node.title}</span>
        {node.badge !== undefined && <span className="cl-node__badge">{node.badge}</span>}
        <span className="cl-node__status" aria-hidden="true">
          <Check className="cl-node__check" />
        </span>
      </div>
      <div className="cl-node__body">
        {node.meta !== undefined && (
          <div className="cl-node__meta-row">
            <span className="cl-node__meta">{node.meta}</span>
          </div>
        )}
        {node.chips !== undefined && (
          <div className="cl-node__chips">
            {node.chips.map((chip) => (
              <span key={chip} className="cl-node__chip">
                {chip}
              </span>
            ))}
          </div>
        )}
        {node.preview !== undefined && (
          <div className="cl-node__preview">
            {node.preview.map((row, rowIndex) => (
              <div key={rowIndex} className="cl-node__preview-row">
                {row.map((cell, cellIndex) => (
                  <span key={cellIndex} className="cl-node__preview-cell">
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {socketsFor(graph, node.id).map((side) => (
        <span key={side} className={`cl-socket cl-socket--${side}`} aria-hidden="true" />
      ))}
    </div>
  )
}

/**
 * Cinematic application loader — a large, living version of the real
 * data-flow Canvas. Real operation accents, node cards, sockets and
 * arrow-marked Bézier wires assemble across the viewport while a slow
 * camera move gives the scene depth. One CSS timeline; no rAF loop and no
 * React re-renders during the sequence. Honors reduced motion (fully formed
 * static canvas) and reduced effects (no atmosphere).
 */
export function AppLoadingScreen({ status, exiting = false }: AppLoadingScreenProps) {
  const viewport = useViewport()
  const mode = pickLoaderMode(viewport.width, viewport.height)
  const graph = useMemo(() => buildGraph(mode), [mode])
  // Desktop fills the frame; smaller compositions leave breathing room at the
  // top and bottom so the brand lockup and live status never sit on a node.
  const fill = mode === 'desktop' ? 0.94 : mode === 'portrait' ? 0.9 : 0.84
  const scale = Math.min(viewport.width / graph.width, viewport.height / graph.height) * fill

  return (
    <div
      className="app-loader canvas-loader"
      aria-busy="true"
      data-mode={mode}
      data-exiting={exiting ? 'true' : undefined}
    >
      <div className="cl-env" aria-hidden="true">
        <div className="cl-grid" />
        <div className="cl-glow" />
        <div className="cl-vignette" />
      </div>

      <div
        className="cl-camera"
        style={{ width: graph.width, height: graph.height, transform: `translate(-50%, -50%) scale(${scale})` }}
      >
        <div className="cl-lens">
          <div className="app-loader__mark cl-drift">
            <div className="cl-graph" style={{ width: graph.width, height: graph.height }}>
              <svg
                className="cl-edges"
                viewBox={`0 0 ${graph.width} ${graph.height}`}
                width={graph.width}
                height={graph.height}
                aria-hidden="true"
              >
                {graph.edges.map((edge) => {
                  const geometry = graph.geometry[edge.id]
                  if (!geometry) return null
                  const style = {
                    color: `var(--node-${edge.accent})`,
                    '--cl-delay': `${edge.delay}s`,
                    '--cl-dur': `${edge.duration}s`,
                  } as CSSProperties
                  return (
                    <g
                      key={edge.id}
                      className="cl-edge"
                      data-accent={edge.accent}
                      data-dashed={edge.dashed === true ? 'true' : undefined}
                      style={style}
                    >
                      <path className="cl-edge__halo" d={geometry.d} pathLength={1} />
                      <path
                        className="cl-edge__line"
                        d={geometry.d}
                        pathLength={edge.dashed === true ? undefined : 1}
                      />
                      <path className="cl-edge__flow" d={geometry.d} pathLength={1} />
                      <path
                        className="cl-edge__arrow"
                        d="M0,0 L-10,-4.6 L-10,4.6 Z"
                        transform={`translate(${geometry.arrow.x} ${geometry.arrow.y}) rotate(${geometry.arrow.angle})`}
                      />
                      {edge.label !== undefined && geometry.label !== undefined && (
                        <g
                          className="cl-edge__label"
                          transform={`translate(${geometry.label.x} ${geometry.label.y})`}
                        >
                          <rect
                            x={-geometry.label.width / 2}
                            y={-9}
                            width={geometry.label.width}
                            height={18}
                            rx={5}
                          />
                          <text textAnchor="middle" y={3.5}>
                            {edge.label}
                          </text>
                        </g>
                      )}
                    </g>
                  )
                })}
              </svg>

              {graph.nodes.map((node) => (
                <LoaderNodeCard key={node.id} node={node} graph={graph} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <header className="cl-brand">
        <span className="cl-brand__mark" aria-hidden="true">
          <Database className="size-4" />
        </span>
        <div className="cl-brand__text">
          <h1 className="cl-brand__name">SQL Visualizer</h1>
          <p className="cl-brand__sub">Local SQL workspace</p>
        </div>
      </header>

      <div className="cl-status">
        <span className="cl-status__dot" aria-hidden="true" />
        <span className="cl-status__label" aria-hidden="true">
          SQLite WASM
        </span>
        <span
          className="cl-status__text"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {MESSAGES[status]}
        </span>
      </div>
    </div>
  )
}