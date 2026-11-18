/**
 * Per-operation accent identity for flow nodes and wires.
 *
 * Keys map to CSS custom properties (`--node-<key>` etc.) defined for
 * both themes in index.css. Keeping the mapping here means the canvas
 * and the nodes always agree on a stage's colour.
 */

import type { FlowGraphNode } from '../../../types/flowGraph'
import type { VisualizedStage } from '../../../types/visualization'

export type NodeAccentKey =
  | 'source'
  | 'join'
  | 'where'
  | 'group'
  | 'having'
  | 'select'
  | 'distinct'
  | 'order'
  | 'limit'
  | 'final'
  | 'rejected'

/** Order used to declare SVG arrowhead markers for every accent. */
export const NODE_ACCENT_KEYS: readonly NodeAccentKey[] = [
  'source',
  'join',
  'where',
  'group',
  'having',
  'select',
  'distinct',
  'order',
  'limit',
  'final',
  'rejected',
]

const STAGE_ACCENT: Record<VisualizedStage, NodeAccentKey> = {
  FROM: 'source',
  JOIN: 'join',
  WHERE: 'where',
  GROUP_BY: 'group',
  HAVING: 'having',
  SELECT: 'select',
  DISTINCT: 'distinct',
  COMPOUND: 'distinct',
  ORDER_BY: 'order',
  LIMIT: 'limit',
}

export function stageAccentKey(stage: VisualizedStage | null): NodeAccentKey {
  return stage === null ? 'final' : STAGE_ACCENT[stage]
}

/** Accent for a node, derived from its kind and real SQL stage. */
export function nodeAccentKey(node: Pick<FlowGraphNode, 'kind' | 'stage'>): NodeAccentKey {
  if (node.kind === 'source') return 'source'
  if (node.kind === 'branch') return 'rejected'
  if (node.kind === 'group') return 'group'
  if (node.kind === 'final') return 'final'
  return stageAccentKey(node.stage)
}

/** CSS colour for an accent key (works in both themes). */
export function accentColor(key: NodeAccentKey): string {
  return `var(--node-${key})`
}
