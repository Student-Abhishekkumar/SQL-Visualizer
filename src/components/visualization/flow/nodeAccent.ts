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
  // DML preview stages reuse the existing accent palette.
  TARGET: 'source',
  INPUT: 'join',
  COLUMN_MAPPING: 'select',
  INSERT: 'select',
  MATCHED_ROWS: 'where',
  SET: 'having',
  CHANGED_ROWS: 'distinct',
  UNCHANGED_ROWS: 'limit',
  DELETE: 'rejected',
  RETAINED_ROWS: 'order',
  FINAL_TABLE: 'final',
  DATABASE: 'source',
  TABLE_DEFINITION: 'select',
  COLUMN_DEFINITIONS: 'select',
  CONSTRAINTS: 'having',
  CREATE_TABLE: 'join',
  ORIGINAL_SCHEMA: 'source',
  ALTER_OPERATION: 'having',
  SCHEMA_TRANSFORMATION: 'distinct',
  RESULTING_SCHEMA: 'final',
  DROP_TABLE: 'rejected',
  REMOVED_TABLE: 'rejected',
  REMAINING_SCHEMA: 'final',
  INDEX_DEFINITION: 'select',
  CREATE_INDEX: 'join',
  INDEX_METADATA: 'final',
  EXISTING_INDEX: 'source',
  DROP_INDEX: 'rejected',
  REMAINING_INDEXES: 'final',
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
