/**
 * Visualization contracts — Stage 2.
 *
 * IMPORTANT: SQLite does NOT expose intermediate execution states
 * (filtered rows, join candidates, grouped buckets). The simulator in
 * services/visualization implements a separate, explicit logical model
 * of SQL processing and generates real educational traces using these
 * types. It is independent of the actual SQLite execution path, and its
 * final result is validated against SQLite's real output.
 *
 * Events and snapshots are deterministic, ordered, serializable and
 * immutable once generated — suitable for playback and seeking.
 */

import type { StatementType } from './query'

// ---------------------------------------------------------------------------
// Logical pipeline stages (SQL logical processing order)
// ---------------------------------------------------------------------------

export type VisualizedStage =
  | 'FROM'
  | 'JOIN'
  | 'WHERE'
  | 'GROUP_BY'
  | 'HAVING'
  | 'SELECT'
  | 'DISTINCT'
  | 'ORDER_BY'
  | 'LIMIT'

export const STAGE_ORDER: readonly VisualizedStage[] = [
  'FROM',
  'JOIN',
  'WHERE',
  'GROUP_BY',
  'HAVING',
  'SELECT',
  'DISTINCT',
  'ORDER_BY',
  'LIMIT',
]

export type StageStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'unsupported'

// ---------------------------------------------------------------------------
// Capability analysis (Milestone 2.2)
// ---------------------------------------------------------------------------

/** A SQL construct the simulator recognized. */
export interface DetectedConstruct {
  kind: string
  detail?: string
}

/**
 * Structured result of analyzing whether a query can be visualized.
 * The simulator only runs when `supported` is true; unsupported queries
 * still execute normally in SQLite.
 */
export interface VisualizationCapability {
  /** The simulator can produce a faithful trace for this query. */
  supported: boolean
  /** Stages that would run (subset of STAGE_ORDER), only when supported. */
  supportedStages: VisualizedStage[]
  /** Stages the query uses but the simulator cannot visualize yet. */
  unsupportedFeatures: DetectedConstruct[]
  /** Everything worth telling the user about how the trace was built. */
  warnings: DetectedConstruct[]
  /** Constructs present in the query (supported or not). */
  detected: DetectedConstruct[]
  /** True when the query only reads data (SELECT without side effects). */
  isReadOnly: boolean
  hasAggregation: boolean
  hasJoin: boolean
  /** Rough input size classification for the UI. */
  estimatedComplexity: 'small' | 'medium' | 'large' | 'unknown'
  /** Why the query cannot be visualized (when unsupported). */
  unsupportedReason?: string
}

// ---------------------------------------------------------------------------
// Rows, groups and snapshots
// ---------------------------------------------------------------------------

/** A row in a visualization snapshot. `id` is stable across stages. */
export interface VisualizedRow {
  id: string
  values: unknown[]
}

/** Column labels for the rows of a snapshot. */
export type RowColumns = string[]

/** One group produced by GROUP BY. */
export interface GroupSnapshot {
  /** Deterministic group ordinal (1-based). */
  index: number
  /** Human-readable key, e.g. "department_id = 1". */
  key: string
  /** Grouping key values (aligned with the GROUP BY expressions). */
  keyValues: unknown[]
  /** Source-row ids belonging to this group. */
  rowIds: string[]
  /** Aggregate results computed for this group, by expression text. */
  aggregates: Record<string, unknown>
}

/** How a specific row participates in the current transformation. */
export type RowRole = 'unchanged' | 'accepted' | 'filtered' | 'duplicated' | 'selected' | 'skipped' | 'grouped'

/** Cell-level emphasis, aligned with the snapshot's columns. */
export interface HighlightInfo {
  rowIds: string[]
  columnIndexes?: number[]
}

/**
 * A full, reproducible visualization state after one logical stage.
 * Immutable once generated.
 */
export interface StageSnapshot {
  stage: VisualizedStage
  /** Short label for the pipeline, e.g. "WHERE salary > 50000". */
  label: string
  /** Column labels of `rows`. */
  columns: RowColumns
  /** Rows that remain after this stage, in presentation order. */
  rows: VisualizedRow[]
  /** Rows removed by this stage (WHERE/HAVING/DISTINCT/OFFSET+LIMIT). */
  removedRows: VisualizedRow[]
  /** Role of each row in this stage's transformation (keyed by row id). */
  roles: Record<string, RowRole>
  /** GROUP BY structure, when this stage grouped the data. */
  groups: GroupSnapshot[]
  /** Aggregate results per group keyed by expression text (GROUP BY stage). */
  explanation: string
  inputRowCount: number
  outputRowCount: number
  /** True when rows were dropped to honor the visualization row limit. */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Events (Milestone: execution events)
// ---------------------------------------------------------------------------

export type VisualizationEventType =
  | 'QUERY_STARTED'
  | 'SOURCE_TABLE_LOADED'
  | 'ROW_EVALUATED'
  | 'ROW_ACCEPTED'
  | 'ROW_FILTERED'
  | 'GROUP_CREATED'
  | 'AGGREGATE_CALCULATED'
  | 'GROUP_FILTERED'
  | 'COLUMN_PROJECTED'
  | 'DUPLICATE_DETECTED'
  | 'ROW_SORTED'
  | 'ROW_SKIPPED'
  | 'ROW_SELECTED'
  | 'STAGE_COMPLETED'
  | 'QUERY_VISUALIZATION_COMPLETED'
  | (string & {})

/**
 * Fine-grained, ordered, serializable execution event. `payload` carries
 * the minimal delta needed for playback; full state arrives with
 * STAGE_COMPLETED events as `snapshot`.
 */
export interface VisualizationEvent {
  id: string
  type: VisualizationEventType
  description: string
  /** Logical stage this event belongs to (null for QUERY_* events). */
  stage: VisualizedStage | null
  payload?: {
    rowId?: string
    /** For ROW_EVALUATED: the condition text and its 3VL verdict. */
    condition?: string
    verdict?: 'true' | 'false' | 'unknown'
    groupKey?: string
    aggregateName?: string
    aggregateValue?: unknown
    /** For ROW_SORTED: from-index and to-index. */
    fromIndex?: number
    toIndex?: number
  }
  /** Full state after a stage completes. */
  snapshot?: StageSnapshot
}

// ---------------------------------------------------------------------------
// Trace and validation
// ---------------------------------------------------------------------------

/**
 * Real metadata about one source table of the query, captured by the
 * simulator while loading data. Previews are genuine table rows (capped
 * for display); `rowCount` is the full table size. Never fabricated.
 */
export interface TraceSourceTable {
  name: string
  alias: string | null
  columns: string[]
  /** Full row count of the real table (not capped). */
  rowCount: number
  /** First rows of the real table, capped for preview display. */
  previewRows: VisualizedRow[]
  role: 'from' | 'join'
  joinType: 'INNER JOIN' | 'LEFT JOIN' | 'CROSS JOIN' | null
  /** ON condition text, when a join. */
  on: string | null
}

export interface VisualizationTrace {
  query: string
  /** Statement type of the visualized statement. */
  statementType: StatementType
  capability: VisualizationCapability
  stages: VisualizedStage[]
  events: VisualizationEvent[]
  /** Snapshot per completed stage, in stage order. */
  stageSnapshots: StageSnapshot[]
  /** Real source tables behind the FROM/JOIN stages. */
  sourceTables: TraceSourceTable[]
  totalSteps: number
  /** Final projected rows of the logical simulation (post LIMIT). */
  finalRows: VisualizedRow[]
  finalColumns: RowColumns
  /**
   * True only when the query's ORDER BY fully determines the final row
   * order (no ties). Validation may compare ordered results only when
   * this is true; ties leave the order to SQLite, so comparison falls
   * back to unordered.
   */
  hasDeterministicOrder: boolean
  /** True when the simulator had to drop rows (row limit). */
  truncated: boolean
}

/** Outcome of comparing the simulation with SQLite's real result. */
export interface ValidationResult {
  /** The simulation matched SQLite (or was not comparable — see method). */
  validated: boolean
  /** How the comparison was performed. */
  method: 'ordered' | 'unordered'
  /** Human-friendly explanation of a mismatch (empty when validated). */
  detail?: string
  /** SQLite column labels. */
  actualColumns?: string[]
  /** Number of rows SQLite returned. */
  actualRowCount?: number
}

// ---------------------------------------------------------------------------
// Playback view state (Milestone: playback controller)
// ---------------------------------------------------------------------------

/** What the UI should render for a given playback position. */
export interface VisualizationViewState {
  eventIndex: number
  event: VisualizationEvent | null
  /** Snapshot of the last completed stage (full current dataset). */
  snapshot: StageSnapshot | null
  /** Stage currently animating (between STAGE_COMPLETED events). */
  activeStage: VisualizedStage | null
  /** Completed stage snapshots in stage order, for pipeline inspection. */
  completedStages: StageSnapshot[]
  finished: boolean
}

/** Contract kept from Stage 1 — now implemented by the simulator host. */
export interface VisualizationEngine {
  readonly name: string
  canVisualize(query: string): boolean
  buildTrace(query: string): VisualizationTrace | null
}
