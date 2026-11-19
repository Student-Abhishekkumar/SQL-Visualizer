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
  | 'COMPOUND'
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
  'COMPOUND',
  'ORDER_BY',
  'LIMIT',
]

export type StageStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'unsupported'

// ---------------------------------------------------------------------------
// Query blocks (nested query identity)
// ---------------------------------------------------------------------------

/**
 * Deterministic id of one query block: `q1` is the root statement and each
 * nested block gets the next id in interpretation order (q2, q3, …).
 */
export type QueryBlockId = string

/** How a query block participates in the statement. */
export type QueryBlockKind = 'root' | 'scalar' | 'in' | 'exists' | 'cte' | 'compound' | 'derived'

/**
 * Block identity shared by snapshots, events, graph nodes and traces.
 *
 * Stage names alone are NOT unique across a statement once nested blocks
 * exist (a subquery has its own WHERE, SELECT, …), so every stage-bearing
 * artifact also carries the owning block.
 */
export interface QueryBlockRef {
  id: QueryBlockId
  kind: QueryBlockKind
  /** Parent block id, null for the root block. */
  parentId: QueryBlockId | null
  /** Nesting depth: the root block is 0. */
  depth: number
  /** Parent stage whose expression consumes this block (null for the root). */
  consumingStage: VisualizedStage | null
}

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
  /**
   * Query block that produced this snapshot. Undefined means the root
   * block (older traces and fixtures predate block identity).
   */
  blockId?: QueryBlockId
  /** Deterministic key for a non-final operation in a compound chain. */
  compoundOperationId?: string
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
  /**
   * True when this snapshot's rows are not the complete relation: the
   * block's own display cap dropped rows, or it consumed an incomplete
   * CTE / nested query result. `truncated` only describes this block's
   * own FROM/JOIN cap; `incomplete` includes inherited dependencies.
   */
  incomplete?: boolean
  /** Human-readable causes of `incomplete`, including upstream CTEs. */
  incompleteReasons?: string[]
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
  /**
   * Query block this event belongs to. Undefined means the root block;
   * nested blocks always set it so two blocks never activate each
   * other's stages during playback.
   */
  blockId?: QueryBlockId
  /** Deterministic key for a non-final operation in a compound chain. */
  compoundOperationId?: string
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
 * Real metadata about one source of the query, captured by the
 * simulator while loading data. Previews are genuine rows (capped for
 * display); `rowCount` is the full size. Never fabricated.
 *
 * `subquery` sources are nested query blocks whose real output feeds the
 * outer pipeline; `cte` sources are ordinary CTE results. Both are
 * resolved to real rows before the outer pipeline runs.
 */
export interface TraceSourceTable {
  name: string
  alias: string | null
  columns: string[]
  /** Full row count of the real source (not capped). */
  rowCount: number
  /** First rows of the real source, capped for preview display. */
  previewRows: VisualizedRow[]
  role: 'from' | 'join' | 'subquery' | 'cte'
  joinType: 'INNER JOIN' | 'LEFT JOIN' | 'CROSS JOIN' | null
  /** ON condition text, when a join. */
  on: string | null
  /** For nested sources: the owning NestedQueryTrace id. */
  queryId?: string
  /** For nested sources: the outer stage that consumes the values. */
  consumerStage?: VisualizedStage | null
  /**
   * Full row count of the real relation. Physical tables are exact, so
   * this is their loaded size. A CTE/subquery whose own input was capped
   * has no known full count, so this is null (never guessed).
   */
  realRowCount?: number | null
  /** True when these rows are a visualization-capped intermediate. */
  incomplete?: boolean
  /** Why the source is incomplete (names the upstream CTE when known). */
  incompleteReasons?: string[]
}

/** How a nested query block participates in the outer query. */
export type NestedQueryKind = 'scalar' | 'in' | 'exists' | 'cte' | 'compound'

/** Set operator of a compound (set-operation) query. */
export type SetOperator = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT'

/** One SELECT branch of a compound query, identified by its block. */
export interface CompoundBranchRef {
  blockId: QueryBlockId
  /** Operator combining this branch with the accumulated result. */
  operator: SetOperator | null
}

/** One left-to-right operation in a compound chain, with its real inputs. */
export interface CompoundOperationTrace {
  /** COMPOUND-1, COMPOUND-2, …; the final operation stays COMPOUND. */
  id: string
  operator: SetOperator
  /** Zero-based index of the branch supplying the next right input. */
  rightBranchIndex: number
  rightBlockId: QueryBlockId
  /** Accumulated rows immediately before this operator ran. */
  leftRows: VisualizedRow[]
  /** Real rows supplied by the next SELECT branch. */
  rightRows: VisualizedRow[]
  /** Actual output and removed rows produced by this operator. */
  snapshot: StageSnapshot
}

/**
 * Compound-query metadata stored on the trace. Branches are recorded by
 * block id in evaluation order, so the graph and UI never infer a branch
 * from display names.
 */
export interface CompoundTraceInfo {
  branches: CompoundBranchRef[]
  /** Actual operation sequence; optional for older trace fixtures. */
  operations?: CompoundOperationTrace[]
}

/**
 * Explicit data dependency between nested blocks. A CTE can read an
 * earlier CTE in the same WITH clause; the edge is recorded by block id,
 * never inferred by matching stage names.
 */
export interface NestedQueryDependency {
  blockId: QueryBlockId
  /** Stage of the dependent block that reads the other block's rows. */
  stage: VisualizedStage
  /**
   * When the dependency was discovered through a nested scalar block,
   * the scalar block that actually read the relation. Undefined for a
   * direct FROM/JOIN dependency.
   */
  viaBlockId?: QueryBlockId
  /** Stage inside the reference where the dependency is consumed. */
  referenceStage?: VisualizedStage
}

/**
 * A fully simulated nested query block. Its snapshots come from the same
 * logical simulator as the outer query, so they are real intermediate
 * rows — never reconstructed from the outer result.
 */
export interface NestedQueryTrace {
  id: string
  kind: NestedQueryKind
  /** Short display label, e.g. "Scalar subquery · AVG(salary)". */
  label: string
  /** Best-effort SQL text for the nested block, rendered from its AST. */
  sql: string
  stageSnapshots: StageSnapshot[]
  finalColumns: RowColumns
  finalRows: VisualizedRow[]
  /** Outer stage whose expression contains this nested block. */
  parentStage: VisualizedStage | null
  /**
   * Canonical name for `parentStage`: the parent stage that consumes this
   * block. The simulator always sets both to the same value.
   */
  consumingStage?: VisualizedStage | null
  /** Parent block id (the root block id when nested in the root query). */
  parentId?: QueryBlockId
  /** Nesting depth relative to the root (root = 0). */
  depth?: number
  /** True when the block reads a column from its parent query. */
  correlated: boolean
  /** Honest caveat (empty result, SQLite first-row rule, …). */
  note?: string
  /**
   * Ordered playback events for this block alone. Their stage names are
   * block-local; `blockId` identifies the owner so playback never mixes
   * blocks.
   */
  events?: VisualizationEvent[]
  /** Lifecycle of the block's own simulation. */
  status?: 'complete' | 'unsupported'
  /** Why the block is unsupported (empty when complete). */
  unavailableReasons?: string[]
  /** True when the block's own simulation dropped rows for display. */
  truncated?: boolean
  /**
   * True when the block's rows are not the complete relation, either
   * because of its own display cap or because it read incomplete
   * upstream CTE/scalar results.
   */
  incomplete?: boolean
  /** Human-readable causes of `incomplete`, naming upstream blocks. */
  incompleteReasons?: string[]
  /** True only when the block's ORDER BY fully determines its row order. */
  hasDeterministicOrder?: boolean
  /** Declared CTE name (CTE blocks only). */
  cteName?: string
  /** Explicit CTE column list from `WITH name(a, b) AS …`, or null. */
  cteColumns?: string[] | null
  /** Set operator that combines this branch with the previous one. */
  setOperator?: SetOperator | null
  /**
   * Earlier query blocks this block reads directly. For CTEs these are
   * the CTE definitions it consumes; the consuming stage is recorded so
   * the graph can wire the exact operation instead of guessing by name.
   */
  dependencies?: NestedQueryDependency[]
}

export interface VisualizationTrace {
  query: string
  /** Statement type of the visualized statement. */
  statementType: StatementType
  capability: VisualizationCapability
  /** Root query block id (q1 unless a trace was built elsewhere). */
  rootBlockId?: QueryBlockId
  stages: VisualizedStage[]
  events: VisualizationEvent[]
  /** Snapshot per completed stage, in stage order. */
  stageSnapshots: StageSnapshot[]
  /** Real source tables behind the FROM/JOIN stages. */
  sourceTables: TraceSourceTable[]
  /** Nested query blocks (scalar subqueries today) with real snapshots. */
  nestedQueries?: NestedQueryTrace[]
  /** Compound-query branch metadata (only for set-operation traces). */
  compound?: CompoundTraceInfo
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
  /**
   * True when this trace's rows are not the complete relation because a
   * display cap or an incomplete upstream CTE/scalar block contributed.
   * `truncated` reports only the trace's own caps.
   */
  incomplete?: boolean
  /** Human-readable causes of `incomplete`, naming upstream CTEs. */
  incompleteReasons?: string[]
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
  /**
   * Independent parity for each nested query block. A nested mismatch is
   * reported separately from the outer result so the UI can say which
   * block disagreed with SQLite.
   */
  nested?: NestedBlockValidation[]
  /**
   * True when the simulation itself was incomplete (a visualization cap
   * or inherited CTE incompleteness), so a match cannot claim parity.
   */
  incomplete?: boolean
  /** Why the simulation is incomplete. */
  incompleteReasons?: string[]
}

/** Parity of one nested query block against SQLite's own execution. */
export interface NestedBlockValidation {
  blockId: QueryBlockId
  label: string
  validated: boolean
  method: 'ordered' | 'unordered'
  /**
   * True when the block could not be compared (truncated for display, or
   * SQLite could not isolate the block). Never a silent pass.
   */
  skipped?: boolean
  detail?: string
  /** True when the block's input was an incomplete/capped intermediate. */
  incomplete?: boolean
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
  /**
   * Block-scoped keys of the completed stages (`q2:WHERE`, bare `WHERE`
   * for the root block). Playback activation compares these, never bare
   * stage names, so two blocks can never activate each other.
   */
  completedStageKeys: string[]
  /** Block-scoped key of the stage currently animating, when any. */
  activeStageKey: string | null
  /** Query block this view state was folded from (null = root block). */
  blockId: QueryBlockId | null
  finished: boolean
}

/** Contract kept from Stage 1 — now implemented by the simulator host. */
export interface VisualizationEngine {
  readonly name: string
  canVisualize(query: string): boolean
  buildTrace(query: string): VisualizationTrace | null
}
