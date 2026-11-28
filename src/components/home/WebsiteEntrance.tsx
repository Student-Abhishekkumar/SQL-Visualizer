import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  Boxes,
  Check,
  Database,
  Filter,
  FilterX,
  GitMerge,
  KeyRound,
  Rows3,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { LoaderAccent } from '../common/canvasLoaderLayout'
import {
  buildEntranceNetwork,
  pickEntranceMode,
  type EntranceEdge,
  type EntranceNetwork,
  type EntranceNode,
} from './entranceNetwork'
import './entrance.css'

/*
 * Website entrance: a three-second, full-screen "living query network" that
 * plays once before the homepage. It is intentionally separate from the
 * application initialization loader (AppLoadingScreen): no readiness state,
 * no SQLite coupling, no artificial delay on the real workspace.
 *
 * Timeline (seconds):
 *   0.00–0.45  environment + anchor nodes wake up
 *   0.45–1.30  secondary nodes and the query ring assemble
 *   1.00–2.30  wires draw, illuminate, and carry travelling data signals
 *   1.95–2.55  the wordmark resolves inside its reserved band
 *   2.70–3.00  handoff to the homepage
 */
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

const PILL_ICONS: Record<NonNullable<EntranceNode['icon']>, LucideIcon> = {
  table: Table2,
  database: Database,
  key: KeyRound,
  rows: Rows3,
  bolt: Zap,
}

function readViewport() {
  if (typeof window === 'undefined') return { width: 1440, height: 900 }
  const vv = window.visualViewport
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight),
  }
}

/** Visual viewport tracking with coalesced measurements (no resize storms). */
function useViewport() {
  const [size, setSize] = useState(readViewport)
  useEffect(() => {
    let frame = 0
    const measure = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setSize(readViewport())
      })
    }
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    window.visualViewport?.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
      window.visualViewport?.removeEventListener('resize', measure)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return size
}

/** Best-effort capability check; CSS still supplies the full experience. */
function isLowPowerDevice() {
  if (typeof navigator === 'undefined') return false
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const cores = navigator.hardwareConcurrency
  return (memory !== undefined && memory <= 4) || (cores !== undefined && cores <= 4)
}

function PrimaryCard({
  node,
  network,
  style,
}: {
  node: EntranceNode
  network: EntranceNetwork
  style: CSSProperties
}) {
  const Icon = ACCENT_ICONS[node.accent]
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
      {(network.sockets[node.id] ?? []).map((side) => (
        <span key={side} className={`cl-socket cl-socket--${side}`} aria-hidden="true" />
      ))}
    </div>
  )
}

function SecondaryPill({ node }: { node: EntranceNode }) {
  const Icon = PILL_ICONS[node.icon ?? 'table']
  const style = {
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    '--cl-delay': `${node.delay}s`,
  } as CSSProperties
  return (
    <div className="en-pill" data-accent={node.accent} style={style}>
      <Icon className="en-pill__icon" aria-hidden="true" />
      <span className="en-pill__label">{node.title}</span>
    </div>
  )
}

function PeripheralDot({ node }: { node: EntranceNode }) {
  const style = {
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    '--cl-delay': `${node.delay}s`,
  } as CSSProperties
  return <span className="en-dot" data-accent={node.accent} style={style} />
}

function EdgeLayer({ network }: { network: EntranceNetwork }) {
  return (
    <svg
      className="cl-edges"
      viewBox={`0 0 ${network.width} ${network.height}`}
      width={network.width}
      height={network.height}
      aria-hidden="true"
    >
      {network.edges.map((edge: EntranceEdge) => {
        const color = `var(--node-${edge.accent}, var(--accent))`
        const style = {
          color,
          '--cl-delay': `${edge.delay}s`,
          '--cl-dur': `${edge.duration}s`,
        } as CSSProperties

        if (edge.weight !== 'pipeline') {
          return (
            <g
              key={edge.id}
              className="en-edge"
              data-weight={edge.weight}
              data-accent={edge.accent}
              style={style}
            >
              <path className="en-edge__line" d={edge.d} vectorEffect="non-scaling-stroke" />
            </g>
          )
        }

        return (
          <g
            key={edge.id}
            className="cl-edge"
            data-accent={edge.accent}
            data-dashed={edge.dashed === true ? 'true' : undefined}
            style={style}
          >
            <path className="cl-edge__halo" d={edge.d} vectorEffect="non-scaling-stroke" />
            <path
              className="cl-edge__line"
              d={edge.d}
              pathLength={edge.dashed === true ? undefined : 1}
              vectorEffect="non-scaling-stroke"
            />
            <path
              className="cl-edge__arrow"
              d="M0,0 L-10,-4.6 L-10,4.6 Z"
              transform={`translate(${edge.arrow.x} ${edge.arrow.y}) rotate(${edge.arrow.angle})`}
            />
            {edge.label !== undefined && edge.labelPos !== undefined && (
              <g
                className="cl-edge__label"
                transform={`translate(${edge.labelPos.x} ${edge.labelPos.y})`}
              >
                <rect
                  x={-edge.labelPos.width / 2}
                  y={-9}
                  width={edge.labelPos.width}
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
  )
}

export function WebsiteEntrance({ exiting = false }: { exiting?: boolean }) {
  const viewport = useViewport()
  const mode = pickEntranceMode(viewport.width, viewport.height)
  const network = useMemo(() => buildEntranceNetwork(mode), [mode])
  const lite = useMemo(() => isLowPowerDevice(), [])
  const fill = mode === 'phone' ? 0.97 : 0.95
  const scale = Math.min(viewport.width / network.width, viewport.height / network.height) * fill
  const rootRef = useRef<HTMLDivElement>(null)

  // Stop all CSS animation work while the tab/page is hidden.
  useEffect(() => {
    const apply = () => {
      const root = rootRef.current
      if (root) root.dataset.paused = document.hidden ? 'true' : 'false'
    }
    document.addEventListener('visibilitychange', apply)
    apply()
    return () => document.removeEventListener('visibilitychange', apply)
  }, [])

  // The wordmark is anchored to the centre of its reserved band, so it travels
  // with the composition at every viewport size instead of being pasted on top.
  const brandX = viewport.width / 2 + (network.brand.x + network.brand.w / 2 - network.width / 2) * scale
  const brandY = viewport.height / 2 + (network.brand.y + network.brand.h / 2 - network.height / 2) * scale
  const brandWidth = network.brand.w * scale

  return (
    <div
      ref={rootRef}
      className="website-entrance"
      aria-hidden="true"
      data-mode={mode}
      data-lite={lite ? 'true' : undefined}
      data-exiting={exiting ? 'true' : undefined}
    >
      <div className="cl-env" aria-hidden="true">
        <div className="cl-grid" />
        <div className="cl-glow" />
        <span className="en-depth en-depth--a" />
        <span className="en-depth en-depth--b" />
        <div className="cl-vignette" />
      </div>

      <div
        className="cl-camera"
        style={{
          width: network.width,
          height: network.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        <div className="cl-lens">
          <div className="entrance-drift">
            <div className="cl-graph" style={{ width: network.width, height: network.height }}>
              <EdgeLayer network={network} />

              {network.signals.map((signal) => (
                <span
                  key={signal.id}
                  className="en-signal"
                  data-accent={signal.accent}
                  style={
                    {
                      offsetPath: `path("${signal.d}")`,
                      '--s-delay': `${signal.delay}s`,
                      '--s-dur': `${signal.duration}s`,
                    } as CSSProperties
                  }
                />
              ))}

              {network.nodes.map((node) => {
                if (node.kind === 'peripheral') return <PeripheralDot key={node.id} node={node} />
                if (node.kind === 'secondary') return <SecondaryPill key={node.id} node={node} />
                return (
                  <PrimaryCard
                    key={node.id}
                    node={node}
                    network={network}
                    style={
                      {
                        left: node.x,
                        top: node.y,
                        width: node.w,
                        height: node.h,
                        '--cl-delay': `${node.delay}s`,
                        '--cl-done': `${node.done}s`,
                      } as CSSProperties
                    }
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div
        className="entrance-brand"
        style={{ left: brandX, top: brandY, '--brand-max': `${Math.round(brandWidth)}px` } as CSSProperties}
      >
        <span className="entrance-brand__mark" aria-hidden="true">
          <Database className="size-4" />
        </span>
        <span className="entrance-brand__rule" aria-hidden="true" />
        <h1 className="entrance-brand__name">SQL Visualizer</h1>
        <p className="entrance-brand__sub">See what your SQL is really doing.</p>
      </div>
    </div>
  )
}
