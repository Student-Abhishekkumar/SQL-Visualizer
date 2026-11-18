/**
 * Query-block identity helpers (Stage 2, nested-block infrastructure).
 *
 * A statement is not one pipeline but a tree of query blocks: the root
 * SELECT plus every nested block (scalar subqueries today). Stage names
 * are only unique inside a block, so every stage-bearing artifact is
 * addressed with a block-scoped key.
 *
 * Key format:
 * - root block (`q1`): the bare stage name — `WHERE`
 * - nested block:        `<blockId>:<stage>` — `q2:WHERE`
 *
 * The root block keeps bare names so existing single-block traces,
 * graphs and tests remain byte-identical; nested blocks are namespaced,
 * which makes accidental collisions impossible.
 */

import type {
  NestedQueryTrace,
  QueryBlockId,
  QueryBlockKind,
  StageSnapshot,
  VisualizationEvent,
  VisualizationTrace,
  VisualizedStage,
} from '../../types/visualization'

/** The root statement always receives the first deterministic block id. */
export const ROOT_BLOCK_ID: QueryBlockId = 'q1'

/** Root block id of a trace (older fixtures may omit it). */
export function rootBlockIdOf(trace: VisualizationTrace | null | undefined): QueryBlockId {
  return trace?.rootBlockId ?? ROOT_BLOCK_ID
}

/** True when the id refers to the root block (or predates block identity). */
export function isRootBlock(
  blockId: QueryBlockId | null | undefined,
  rootBlockId: QueryBlockId = ROOT_BLOCK_ID,
): boolean {
  return blockId === null || blockId === undefined || blockId === rootBlockId
}

/**
 * Block-scoped stage key. Root stages stay bare; nested stages are
 * namespaced with their block id.
 */
export function stageKeyFor(
  blockId: QueryBlockId | null | undefined,
  stage: VisualizedStage,
  rootBlockId: QueryBlockId = ROOT_BLOCK_ID,
): string {
  if (isRootBlock(blockId, rootBlockId)) return stage
  return `${blockId}:${stage}`
}

/** Split a block-scoped key back into its block id (null for root). */
export function splitStageKey(
  key: string,
  rootBlockId: QueryBlockId = ROOT_BLOCK_ID,
): { blockId: QueryBlockId | null; stage: VisualizedStage } {
  const separator = key.indexOf(':')
  if (separator < 0) return { blockId: null, stage: key as VisualizedStage }
  const blockId = key.slice(0, separator)
  return {
    blockId: blockId === rootBlockId ? null : blockId,
    stage: key.slice(separator + 1) as VisualizedStage,
  }
}

/** Block-scoped key of a snapshot. */
export function snapshotStageKey(
  snapshot: StageSnapshot,
  rootBlockId: QueryBlockId = ROOT_BLOCK_ID,
): string {
  return stageKeyFor(snapshot.blockId, snapshot.stage, rootBlockId)
}

/** Block-scoped key of an event's stage (null when the event has none). */
export function eventStageKey(
  event: VisualizationEvent,
  rootBlockId: QueryBlockId = ROOT_BLOCK_ID,
): string | null {
  if (event.stage === null) return null
  return stageKeyFor(event.blockId, event.stage, rootBlockId)
}

/** Every nested query block of a trace, in interpretation order. */
export function nestedBlocksOf(trace: VisualizationTrace | null | undefined): NestedQueryTrace[] {
  return trace?.nestedQueries ?? []
}

/** One nested block by id. */
export function nestedBlockOf(
  trace: VisualizationTrace | null | undefined,
  blockId: QueryBlockId | null | undefined,
): NestedQueryTrace | null {
  if (blockId === null || blockId === undefined) return null
  return nestedBlocksOf(trace).find((block) => block.id === blockId) ?? null
}

/** Direct children of a block (root by default). */
export function childBlocksOf(
  trace: VisualizationTrace | null | undefined,
  parentId: QueryBlockId | null | undefined,
): NestedQueryTrace[] {
  const parent = parentId ?? rootBlockIdOf(trace)
  return nestedBlocksOf(trace).filter((block) => (block.parentId ?? rootBlockIdOf(trace)) === parent)
}

/** Stages a block runs through (root: the trace timeline). */
export function blockStages(
  trace: VisualizationTrace,
  blockId: QueryBlockId | null | undefined,
): VisualizedStage[] {
  if (isRootBlock(blockId, rootBlockIdOf(trace))) return trace.stages
  const block = nestedBlockOf(trace, blockId)
  if (block === null) return []
  return block.stageSnapshots.map((snapshot) => snapshot.stage)
}

/** Snapshots of one block, in stage order. */
export function blockSnapshots(
  trace: VisualizationTrace,
  blockId: QueryBlockId | null | undefined,
): StageSnapshot[] {
  if (isRootBlock(blockId, rootBlockIdOf(trace))) return trace.stageSnapshots
  return nestedBlockOf(trace, blockId)?.stageSnapshots ?? []
}

/**
 * Playback timeline of one block. Nested blocks carry their own events;
 * the root block uses the trace timeline. Returns an empty array when a
 * block has no recorded events (older traces), never another block's.
 */
export function blockEvents(
  trace: VisualizationTrace | null | undefined,
  blockId: QueryBlockId | null | undefined,
): VisualizationEvent[] {
  if (trace === null || trace === undefined) return []
  if (isRootBlock(blockId, rootBlockIdOf(trace))) return trace.events
  return nestedBlockOf(trace, blockId)?.events ?? []
}

/** Lightweight descriptor used by the pipeline block selector. */
export interface QueryBlockDescriptor {
  id: QueryBlockId
  label: string
  kind: QueryBlockKind
  depth: number
  parentId: QueryBlockId | null
  stageCount: number
  /** Completed blocks are playable; unsupported ones are listed but inert. */
  playable: boolean
}

function kindOf(block: NestedQueryTrace): QueryBlockKind {
  return block.kind
}

/** True when the trace's root block is a UNION / UNION ALL compound. */
export function isCompoundTrace(trace: VisualizationTrace | null | undefined): boolean {
  return trace?.compound !== undefined || trace?.stages.includes('COMPOUND') === true
}

/**
 * All blocks of a trace (root first, then nested in interpretation
 * order) with the metadata the UI needs to identify them.
 */
export function blocksOf(trace: VisualizationTrace): QueryBlockDescriptor[] {
  const rootId = rootBlockIdOf(trace)
  const blocks: QueryBlockDescriptor[] = [
    {
      id: rootId,
      label: isCompoundTrace(trace) ? 'Compound result' : 'Outer query',
      kind: 'root',
      depth: 0,
      parentId: null,
      stageCount: trace.stages.length,
      playable: trace.events.length > 0,
    },
  ]
  for (const block of nestedBlocksOf(trace)) {
    blocks.push({
      id: block.id,
      label: block.label,
      kind: kindOf(block),
      depth: block.depth ?? 1,
      parentId: block.parentId ?? rootId,
      stageCount: block.stageSnapshots.length,
      playable: (block.events?.length ?? 0) > 0 && block.status !== 'unsupported',
    })
  }
  return blocks
}

/** Human label for a block id (root falls back to "Outer query"). */
export function blockLabelOf(
  trace: VisualizationTrace | null | undefined,
  blockId: QueryBlockId | null | undefined,
): string {
  if (trace === null || trace === undefined) return 'Outer query'
  if (isRootBlock(blockId, rootBlockIdOf(trace))) {
    return isCompoundTrace(trace) ? 'Compound result' : 'Outer query'
  }
  return nestedBlockOf(trace, blockId)?.label ?? String(blockId)
}
