/**
 * Logical execution simulator (Stage 2, Milestone 2.3).
 *
 * Processes real table data through the logical SQL pipeline
 * FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT →
 * ORDER BY → LIMIT and emits a deterministic, ordered, serializable
 * event trace with immutable snapshots per stage.
 *
 * Guarantees:
 * - Data comes exclusively from the provided accessor (the live SQLite
 *   database in the app) — nothing is hardcoded or mocked.
 * - The simulation never mutates database state.
 * - Unsupported or unresolvable constructs abort the simulation with
 *   explicit reasons instead of producing misleading traces.
 * - Row identities (`VisualizedRow.id`) are stable across stages and
 *   never derived from array positions that can move.
 * - Snapshot/event generation is capped (row/event limits); truncation
 *   is always reported and never affects real SQLite results.
 */

import { interpretQuery, structureText, type Expression, type QueryStructure, type SelectItem, type StarExpr, type SubqueryExpr } from './astInterpreter'
import { rowKey } from './rowIdentity'
import { detectCorrelation } from './correlation'
import {
  collationOfExpression,
  evaluateAggregate,
  evaluateCondition,
  evaluateExpression,
  explicitCollationOf,
  metadataOfExpression,
  EvaluationError,
  type EvalVerdict,
  type RowContext,
} from './expressionEvaluator'
import {
  compareValues,
  normalizeKeyValue,
  UNKNOWN_COLUMN_META,
  type CollationName,
  type ColumnMeta,
} from './sqliteAffinity'
import type {
  GroupSnapshot,
  NestedQueryDependency,
  NestedQueryTrace,
  CompoundOperationTrace,
  StageSnapshot,
  TraceSourceTable,
  VisualizedRow,
  VisualizedStage,
  VisualizationCapability,
  VisualizationEvent,
  VisualizationTrace,
} from '../../types/visualization'

/** A table's data as read from the database. */
export interface TableData {
  /** Column names in table order. */
  columns: string[]
  /** Row values aligned with `columns`. */
  rows: unknown[][]
  /**
   * Declared affinity/collation per column, aligned with `columns`.
   * Optional so fixtures without schema metadata keep the historical
   * behaviour (no comparison-time affinity conversion, BINARY collation).
   */
  columnMeta?: (ColumnMeta | null)[]
}

/** Options that bound the cost of simulation. */
export interface SimulationOptions {
  /** Maximum source/joined rows kept in the trace. Default 500. */
  maxRows?: number
  /** Maximum fine-grained events. Default 2000. */
  maxEvents?: number
}

const DEFAULT_MAX_ROWS = 500
const DEFAULT_MAX_EVENTS = 2000

export type SimulationOutcome =
  | { ok: true; trace: VisualizationTrace }
  | { ok: false; reasons: string[] }

// ---------------------------------------------------------------------------
// Internal row model
// ---------------------------------------------------------------------------

/**
 * A row in the simulated pipeline: stable id plus values aligned with
 * the current resolution labels. Group rows additionally carry the
 * group ordinal, key values, and a representative source row (SQLite
 * picks an arbitrary row for bare columns — we deterministically pick
 * the first row of the group).
 */
interface SimRow {
  id: string
  values: unknown[]
  groupIndex?: number
  keyValues?: unknown[]
  representative?: SimRow
}

interface SimState {
  /** Labels used for column resolution (qualified where aliases exist). */
  columnLabels: string[]
  /** Display labels for snapshots (bare names where unambiguous). */
  displayLabels: string[]
  /** SQLite output names for source columns, aligned with `columnLabels`. */
  sourceColumnNames: string[]
  /** Affinity/collation metadata aligned with `columnLabels`. */
  columnMeta: ColumnMeta[]
  rows: SimRow[]
  /** True when this block's own FROM/JOIN dropped rows for display. */
  truncated: boolean
  /**
   * True when the dataset is not the complete relation: own display cap
   * or an incomplete CTE / nested query input. Kept separate from
   * `truncated`, which only describes this block's own cap.
   */
  incomplete: boolean
  /** Accumulated causes of `incomplete`, including upstream CTEs. */
  incompleteReasons: string[]
  /** Values of nested query blocks, keyed by SubqueryExpr.id. */
  subqueryValues?: ReadonlyMap<string, unknown>
  /** Output metadata of nested blocks, keyed by SubqueryExpr.id. */
  subqueryColumnMeta?: ReadonlyMap<string, ColumnMeta>
  /** Aggregates per group index, keyed by aggregate expression text. */
  aggregateValues?: Map<number, Record<string, unknown>>
  /** Groups produced by GROUP BY, kept in creation order. */
  groups?: GroupSnapshot[]
  groupByExpressions?: Expression[]
}

interface BuildEvent {
  type: VisualizationEvent['type']
  stage: VisualizationEvent['stage']
  /** Non-final compound operation key used to order repeated stages. */
  compoundOperationId?: string
  description: string
  payload?: VisualizationEvent['payload']
  snapshot?: VisualizationEvent['snapshot']
}

/** A projected output row plus the context for resolving ORDER BY. */
interface ProjectedRow {
  id: string
  values: unknown[]
  sortContext: RowContext
}

/** Errors that abort the whole simulation with explicit reasons. */
class SimulationAbort extends Error {
  reasons: string[]
  constructor(reasons: string[]) {
    super(reasons[0] ?? 'Simulation aborted.')
    this.reasons = reasons
    this.name = 'SimulationAbort'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function evaluationMessage(error: unknown, where: string): string {
  if (error instanceof EvaluationError) {
    return `The ${where} could not be evaluated: ${error.message}`
  }
  return `The ${where} could not be evaluated: ${String(error)}`
}

function displayLabelForItem(item: SelectItem): string {
  if (item.alias !== null) return item.alias
  const expr = item.expression
  if (expr.kind === 'column') return expr.name
  return expr.text
}

/** Sort comparator implementing SQLite NULL ordering (NULLs smallest). */
function sortCompare(
  a: unknown,
  b: unknown,
  descending: boolean,
  collation: CollationName = 'BINARY',
): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  let result: number
  if (aNull && bNull) result = 0
  else if (aNull) result = -1
  else if (bNull) result = 1
  else result = compareValues(a, b, collation)
  if (result === 0) return 0
  return descending ? -result : result
}

function contextOf(
  labels: string[],
  values: unknown[],
  aggregates?: Record<string, unknown>,
  subqueryValues?: ReadonlyMap<string, unknown>,
  columnMeta?: ReadonlyArray<ColumnMeta | null | undefined>,
  subqueryColumnMeta?: ReadonlyMap<string, ColumnMeta>,
): RowContext {
  return { columns: labels, values, aggregates, subqueryValues, columnMeta, subqueryColumnMeta }
}

function splitDisplayLabel(label: string): { table: string | null; name: string } {
  const dot = label.lastIndexOf('.')
  if (dot >= 0) return { table: label.slice(0, dot), name: label.slice(dot + 1) }
  return { table: null, name: label }
}

/** Stable, duplicate-free list of incompleteness reasons. */
function uniqueReasons(reasons: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const reason of reasons) {
    const trimmed = reason.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    unique.push(trimmed)
  }
  return unique
}

/**
 * Why a source relation is incomplete. A CTE is named so downstream
 * inspectors can identify the upstream block responsible, even when the
 * CTE itself inherited the incompleteness from an earlier one.
 */
function sourceIncompleteReason(relation: ResolvedRelation): string {
  if (relation.cte !== null) {
    const causes = relation.incompleteReasons.length > 0
      ? relation.incompleteReasons.join('; ')
      : 'its result was capped for display'
    return `Reads incomplete CTE "${relation.cte.name}": ${causes}`
  }
  return relation.incompleteReasons[0] ?? 'The source relation is incomplete.'
}

/** Why this block's own display cap applies (never a SQLite result cap). */
function capReason(name: string, shown: number, total: number): string {
  return `"${name}" was capped at ${shown} of ${total} rows for visualization; SQLite processes every row.`
}

// ---------------------------------------------------------------------------
// FROM / JOIN
// ---------------------------------------------------------------------------

function loadFrom(
  structure: QueryStructure,
  relation: ResolvedRelation,
  maxRows: number,
): SimState {
  const base = structure.from
  const alias = base.alias ?? base.name
  const data = relation.data
  const keptRows = data.rows.slice(0, maxRows)
  const reasons: string[] = []
  if (relation.incomplete) reasons.push(sourceIncompleteReason(relation))
  if (data.rows.length > keptRows.length) {
    reasons.push(capReason(relation.cte?.name ?? structure.from.name, keptRows.length, data.rows.length))
  }
  return {
    columnLabels: data.columns.map((column) => `${alias}.${column}`),
    displayLabels: [...data.columns],
    sourceColumnNames: [...data.columns],
    columnMeta: data.columns.map((_, index) => data.columnMeta?.[index] ?? UNKNOWN_COLUMN_META),
    rows: keptRows.map((values, index) => ({
      id: `${base.name}#${index + 1}`,
      values: [...values],
    })),
    truncated: data.rows.length > keptRows.length,
    incomplete: reasons.length > 0,
    incompleteReasons: uniqueReasons(reasons),
  }
}

function joinStage(
  state: SimState,
  structure: QueryStructure,
  joinRelations: ResolvedRelation[],
  maxRows: number,
): void {
  structure.joins.forEach((join, joinIndex) => {
    const relation = joinRelations[joinIndex]
    if (relation === undefined) {
      throw new SimulationAbort([`Table "${join.table.name}" does not exist in the current database.`])
    }
    const data = relation.data
    const alias = join.table.alias ?? join.table.name
    const rightLabels = data.columns.map((column) => `${alias}.${column}`)
    const rightDisplay = data.columns.map((column) =>
      state.displayLabels.includes(column) ? `${alias}.${column}` : column,
    )

    const joinedRows: SimRow[] = []
    let truncated = state.truncated
    let joinCapped = false
    const reasons: string[] = []
    if (relation.incomplete) reasons.push(sourceIncompleteReason(relation))

    for (const leftRow of state.rows) {
      let matched = 0
      for (let r = 0; r < data.rows.length; r++) {
        const rightValues = data.rows[r]
        if (rightValues === undefined) continue
        if (joinedRows.length >= maxRows) {
          truncated = true
          joinCapped = true
          break
        }
        if (join.on !== null) {
          let verdict: EvalVerdict
          try {
            verdict = evaluateCondition(join.on, {
              columns: [...state.columnLabels, ...rightLabels],
              values: [...leftRow.values, ...rightValues],
              subqueryValues: state.subqueryValues,
              subqueryColumnMeta: state.subqueryColumnMeta,
              columnMeta: [
                ...state.columnMeta,
                ...data.columns.map((_, index) => data.columnMeta?.[index] ?? UNKNOWN_COLUMN_META),
              ],
            })
          } catch (error) {
            throw new SimulationAbort([evaluationMessage(error, 'JOIN condition')])
          }
          if (verdict !== 'true') continue
        }
        matched++
        joinedRows.push({
          id: `${leftRow.id}+${join.table.name}#${r + 1}`,
          values: [...leftRow.values, ...rightValues],
        })
      }
      if (join.type === 'LEFT JOIN' && matched === 0 && joinedRows.length < maxRows) {
        joinedRows.push({
          id: `${leftRow.id}+null`,
          values: [...leftRow.values, ...data.columns.map(() => null)],
        })
      }
    }

    if (joinCapped) {
      reasons.push(
        `The JOIN output was capped at ${maxRows} rows for visualization; SQLite processes every matching row.`,
      )
    }
    state.columnLabels = [...state.columnLabels, ...rightLabels]
    state.displayLabels = [...state.displayLabels, ...rightDisplay]
    state.sourceColumnNames = [...state.sourceColumnNames, ...data.columns]
    state.columnMeta = [
      ...state.columnMeta,
      ...data.columns.map((_, index) => data.columnMeta?.[index] ?? UNKNOWN_COLUMN_META),
    ]
    state.rows = joinedRows
    state.truncated = state.truncated || truncated
    state.incompleteReasons = uniqueReasons([...state.incompleteReasons, ...reasons])
    state.incomplete = state.incomplete || truncated || reasons.length > 0
  })
}

// ---------------------------------------------------------------------------
// Clause alias resolution
// ---------------------------------------------------------------------------

/**
 * SQLite prefers a source column when an output alias has the same name.
 * An alias is used only when the unqualified name is absent from the source
 * scope. Substitution is structural, so `WHERE i + 1 > 2` evaluates the
 * aliased expression instead of treating the alias as a string. Substituted
 * expressions are not re-resolved, matching SQLite's rule that aliases are
 * not visible inside other output expressions.
 */
function resolveClauseAliases(
  expr: Expression,
  selectItems: readonly SelectItem[],
  sourceLabels: readonly string[],
): Expression {
  const aliases = new Map<string, Expression>()
  for (const item of selectItems) {
    if (item.alias === null || item.expression.kind === 'star') continue
    const key = item.alias.toLowerCase()
    if (!aliases.has(key)) aliases.set(key, item.expression)
  }
  const sourceNames = new Set(
    sourceLabels.map((label) => splitDisplayLabel(label).name.toLowerCase()),
  )

  const walk = (node: Expression, allowAlias: boolean): Expression => {
    switch (node.kind) {
      case 'column': {
        if (node.table !== null || !allowAlias) return node
        const name = node.name.toLowerCase()
        if (sourceNames.has(name)) return node
        return aliases.get(name) ?? node
      }
      case 'comparison': {
        const left = walk(node.left, allowAlias)
        const right = walk(node.right, allowAlias)
        return left === node.left && right === node.right
          ? node
          : { ...node, left, right }
      }
      case 'logical': {
        const left = walk(node.left, allowAlias)
        const right = walk(node.right, allowAlias)
        return left === node.left && right === node.right
          ? node
          : { ...node, left, right }
      }
      case 'arithmetic': {
        const left = walk(node.left, allowAlias)
        const right = walk(node.right, allowAlias)
        return left === node.left && right === node.right
          ? node
          : { ...node, left, right }
      }
      case 'not': {
        const operand = walk(node.operand, allowAlias)
        return operand === node.operand ? node : { ...node, operand }
      }
      case 'unary_minus': {
        const operand = walk(node.operand, allowAlias)
        return operand === node.operand ? node : { ...node, operand }
      }
      case 'collate': {
        const operand = walk(node.operand, allowAlias)
        return operand === node.operand ? node : { ...node, operand }
      }
      case 'list': {
        const exprs = node.exprs.map((item) => walk(item, allowAlias))
        return exprs.every((item, index) => item === node.exprs[index])
          ? node
          : { ...node, exprs }
      }
      case 'in_subquery': {
        const left = walk(node.left, allowAlias)
        return left === node.left ? node : { ...node, left }
      }
      default:
        return node
    }
  }

  return walk(expr, true)
}

// ---------------------------------------------------------------------------
// WHERE
// ---------------------------------------------------------------------------

function whereStage(
  state: SimState,
  structure: QueryStructure,
  pushFine: (event: BuildEvent) => boolean,
): SimRow[] {
  const where = structure.where
  if (where === null) return []
  const resolvedWhere = resolveClauseAliases(where, structure.selectItems, state.columnLabels)
  const kept: SimRow[] = []
  const filtered: SimRow[] = []
  for (const row of state.rows) {
    let verdict: EvalVerdict
    try {
      verdict = evaluateCondition(resolvedWhere, contextOf(state.columnLabels, row.values, undefined, state.subqueryValues, state.columnMeta, state.subqueryColumnMeta))
    } catch (error) {
      throw new SimulationAbort([evaluationMessage(error, 'WHERE condition')])
    }
    if (verdict === 'true') {
      pushFine({
        type: 'ROW_EVALUATED',
        stage: 'WHERE',
        description: `Row ${row.id} satisfies ${where.text}.`,
        payload: { rowId: row.id, condition: where.text, verdict },
      })
      pushFine({
        type: 'ROW_ACCEPTED',
        stage: 'WHERE',
        description: `Row ${row.id} passes the WHERE filter.`,
        payload: { rowId: row.id },
      })
      kept.push(row)
    } else {
      pushFine({
        type: 'ROW_EVALUATED',
        stage: 'WHERE',
        description:
          verdict === 'unknown'
            ? `Row ${row.id} evaluates to UNKNOWN (${where.text}) because a value is NULL — SQLite treats UNKNOWN as false.`
            : `Row ${row.id} does not satisfy ${where.text}.`,
        payload: { rowId: row.id, condition: where.text, verdict },
      })
      pushFine({
        type: 'ROW_FILTERED',
        stage: 'WHERE',
        description: `Row ${row.id} is filtered out by ${where.text}.`,
        payload: { rowId: row.id },
      })
      filtered.push(row)
    }
  }
  state.rows = kept
  return filtered
}

// ---------------------------------------------------------------------------
// GROUP BY / aggregates / HAVING
// ---------------------------------------------------------------------------

function computeAggregates(
  rows: SimRow[],
  structure: QueryStructure,
  columnLabels: string[],
  subqueryValues?: ReadonlyMap<string, unknown>,
  columnMeta?: ReadonlyArray<ColumnMeta | null | undefined>,
  subqueryColumnMeta?: ReadonlyMap<string, ColumnMeta>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const seen = new Set<string>()
  const contexts = rows.map((row) =>
    contextOf(columnLabels, row.values, undefined, subqueryValues, columnMeta, subqueryColumnMeta),
  )
  for (const call of structure.aggregates) {
    if (seen.has(call.text)) continue
    seen.add(call.text)
    if (call.argument === null && call.name === 'COUNT') {
      result[call.text] = rows.length
      continue
    }
    result[call.text] = evaluateAggregate(call, contexts)
  }
  return result
}

/**
 * Build the evaluation context for a group row: the representative row's
 * values plus the group's computed aggregates. Bare columns therefore
 * resolve like SQLite's arbitrary-row behavior.
 */
function groupContext(state: SimState, row: SimRow): RowContext {
  const groupIndex = row.groupIndex ?? 0
  const aggregates = state.aggregateValues?.get(groupIndex) ?? {}
  const representative = row.representative
  const baseValues = representative !== undefined ? representative.values : state.columnLabels.map(() => null)
  const labels = [...state.columnLabels, ...Object.keys(aggregates)]
  const values = [...baseValues, ...Object.values(aggregates)]
  const columnMeta: ColumnMeta[] = [
    ...state.columnMeta,
    ...Object.keys(aggregates).map(() => UNKNOWN_COLUMN_META),
  ]
  return contextOf(labels, values, aggregates, state.subqueryValues, columnMeta, state.subqueryColumnMeta)
}

function groupStage(
  state: SimState,
  structure: QueryStructure,
  pushFine: (event: BuildEvent) => boolean,
): void {
  const hasAggregates = structure.aggregates.length > 0
  const groupBy = structure.groupBy
  if (groupBy.length === 0 && !hasAggregates) return
  const resolvedGroupBy = groupBy.map((expr) =>
    resolveClauseAliases(expr, structure.selectItems, state.columnLabels),
  )

  if (groupBy.length === 0) {
    // Implicit single group over all rows (SQLite behavior).
    const allRows = [...state.rows]
    const aggregateValues = computeAggregates(
      allRows,
      structure,
      state.columnLabels,
      state.subqueryValues,
      state.columnMeta,
      state.subqueryColumnMeta,
    )
    state.aggregateValues = new Map([[0, aggregateValues]])
    const representative = allRows[0]
    state.groups = [
      {
        index: 1,
        key: 'ALL ROWS',
        keyValues: [],
        rowIds: allRows.map((row) => row.id),
        aggregates: aggregateValues,
      },
    ]
    state.groupByExpressions = []
    state.rows = [
      {
        id: 'group#1',
        values: [],
        groupIndex: 0,
        keyValues: [],
        representative,
      },
    ]
    return
  }

  const buckets = new Map<string, { keyValues: unknown[]; rows: SimRow[] }>()
  const orderedKeys: string[] = []
  // Collation is fixed per GROUP BY term, so it is resolved once. It may
  // abort (unsupported declared collation) before any row is grouped.
  const emptyContext = contextOf(
    state.columnLabels,
    state.columnLabels.map(() => null),
    undefined,
    state.subqueryValues,
    state.columnMeta,
    state.subqueryColumnMeta,
  )
  let groupCollations: CollationName[]
  try {
    groupCollations = resolvedGroupBy.map((expr) => collationOfExpression(expr, emptyContext))
  } catch (error) {
    throw new SimulationAbort([evaluationMessage(error, 'GROUP BY collation')])
  }
  for (const row of state.rows) {
    const keyValues: unknown[] = []
    for (const expr of resolvedGroupBy) {
      try {
        keyValues.push(evaluateExpression(expr, contextOf(state.columnLabels, row.values, undefined, state.subqueryValues, state.columnMeta, state.subqueryColumnMeta)))
      } catch (error) {
        throw new SimulationAbort([evaluationMessage(error, 'GROUP BY expression')])
      }
    }
    const key = rowKey(
      keyValues.map((value, index) => normalizeKeyValue(value, groupCollations[index] ?? 'BINARY')),
    )
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { keyValues, rows: [] }
      buckets.set(key, bucket)
      orderedKeys.push(key)
    }
    bucket.rows.push(row)
  }

  const groups: GroupSnapshot[] = []
  const aggregatePerGroup = new Map<number, Record<string, unknown>>()
  const newRows: SimRow[] = []

  orderedKeys.forEach((key, index) => {
    const bucket = buckets.get(key)
    if (bucket === undefined) return
    const aggregateValues = computeAggregates(
      bucket.rows,
      structure,
      state.columnLabels,
      state.subqueryValues,
      state.columnMeta,
      state.subqueryColumnMeta,
    )
    aggregatePerGroup.set(index, aggregateValues)
    const keyText = groupBy
      .map((expr, i) => `${expr.text} = ${String(bucket.keyValues[i])}`)
      .join(', ')
    groups.push({
      index: index + 1,
      key: keyText,
      keyValues: bucket.keyValues,
      rowIds: bucket.rows.map((row) => row.id),
      aggregates: aggregateValues,
    })
    pushFine({
      type: 'GROUP_CREATED',
      stage: 'GROUP_BY',
      description: `Group ${index + 1} collects ${bucket.rows.length} row${bucket.rows.length === 1 ? '' : 's'} where ${keyText}.`,
      payload: { groupKey: keyText },
    })
    for (const [aggregateText, value] of Object.entries(aggregateValues)) {
      pushFine({
        type: 'AGGREGATE_CALCULATED',
        stage: 'GROUP_BY',
        description: `${aggregateText} for group ${index + 1} (${keyText}) = ${String(value)}.`,
        payload: { groupKey: keyText, aggregateName: aggregateText, aggregateValue: value },
      })
    }
    newRows.push({
      id: `group#${index + 1}`,
      values: [...bucket.keyValues],
      groupIndex: index,
      keyValues: bucket.keyValues,
      representative: bucket.rows[0],
    })
  })

  state.aggregateValues = aggregatePerGroup
  state.groups = groups
  state.groupByExpressions = groupBy
  state.rows = newRows
}

function havingStage(
  state: SimState,
  structure: QueryStructure,
  pushFine: (event: BuildEvent) => boolean,
): SimRow[] {
  const having = structure.having
  if (having === null) return []
  if (state.groups === undefined) {
    throw new SimulationAbort(['HAVING requires grouping, which this query does not have.'])
  }
  const resolvedHaving = resolveClauseAliases(having, structure.selectItems, state.columnLabels)
  const kept: SimRow[] = []
  const removed: SimRow[] = []
  for (const row of state.rows) {
    let verdict: EvalVerdict
    try {
      verdict = evaluateCondition(resolvedHaving, groupContext(state, row))
    } catch (error) {
      throw new SimulationAbort([evaluationMessage(error, 'HAVING condition')])
    }
    const group = state.groups.find((candidate) => candidate.index === (row.groupIndex ?? 0) + 1)
    const keyText = group?.key ?? `group ${(row.groupIndex ?? 0) + 1}`
    pushFine({
      type: verdict === 'false' ? 'GROUP_FILTERED' : 'ROW_EVALUATED',
      stage: 'HAVING',
      description:
        verdict === 'true'
          ? `Group (${keyText}) satisfies HAVING ${having.text}.`
          : verdict === 'unknown'
            ? `Group (${keyText}) evaluates to UNKNOWN (${having.text}) — treated as filtered out.`
            : `Group (${keyText}) is removed by HAVING ${having.text}.`,
      payload: { rowId: row.id, condition: having.text, verdict },
    })
    if (verdict === 'true') kept.push(row)
    else removed.push(row)
  }
  const keptIndexes = new Set(kept.map((row) => row.groupIndex ?? -1))
  state.groups = state.groups.filter((group) => keptIndexes.has(group.index - 1))
  state.rows = kept
  return removed
}

// ---------------------------------------------------------------------------
// SELECT projection
// ---------------------------------------------------------------------------

/** Resolve `*` / `table.*` to the source columns visible in this block. */
function starColumnIndexes(star: StarExpr, state: SimState): number[] {
  const qualifier = star.table === null ? null : star.table.toLowerCase()
  const indexes: number[] = []
  for (let i = 0; i < state.columnLabels.length; i++) {
    const label = state.columnLabels[i] ?? ''
    const { table } = splitDisplayLabel(label)
    if (qualifier === null || (table ?? '').toLowerCase() === qualifier) indexes.push(i)
  }
  if (qualifier !== null && indexes.length === 0) {
    throw new SimulationAbort([
      `Wildcard "${star.table}.*" does not match a table or alias in this query block.`,
    ])
  }
  return indexes
}

function projectRows(state: SimState, structure: QueryStructure): {
  /** Qualified labels used for intermediate snapshots and resolution. */
  columns: string[]
  /** SQLite-compatible output names exposed as the block's final columns. */
  outputColumns: string[]
  /** Affinity/collation of each output column, aligned with `columns`. */
  outputMeta: ColumnMeta[]
  rows: ProjectedRow[]
} {
  const columns: string[] = []
  const outputColumns: string[] = []
  const outputMeta: ColumnMeta[] = []
  const starIndexes = new Map<number, number[]>()
  const metaContext = contextOf(
    state.columnLabels,
    state.columnLabels.map(() => null),
    undefined,
    state.subqueryValues,
    state.columnMeta,
    state.subqueryColumnMeta,
  )

  structure.selectItems.forEach((item, itemIndex) => {
    if (item.expression.kind === 'star') {
      const indexes = starColumnIndexes(item.expression, state)
      starIndexes.set(itemIndex, indexes)
      for (const index of indexes) {
        columns.push(state.displayLabels[index] ?? '')
        outputColumns.push(state.sourceColumnNames[index] ?? '')
        outputMeta.push({ ...(state.columnMeta[index] ?? UNKNOWN_COLUMN_META) })
      }
      return
    }
    const label = displayLabelForItem(item)
    columns.push(label)
    outputColumns.push(label)
    outputMeta.push(metadataOfExpression(item.expression, metaContext))
  })

  const rows: ProjectedRow[] = []
  for (const row of state.rows) {
    const ctx =
      row.groupIndex !== undefined
        ? groupContext(state, row)
        : contextOf(state.columnLabels, row.values, undefined, state.subqueryValues, state.columnMeta, state.subqueryColumnMeta)

    const values: unknown[] = []
    structure.selectItems.forEach((item, itemIndex) => {
      const indexes = starIndexes.get(itemIndex)
      if (indexes !== undefined) {
        for (const index of indexes) values.push(ctx.values[index])
        return
      }
      try {
        values.push(evaluateExpression(item.expression, ctx))
      } catch (error) {
        throw new SimulationAbort([evaluationMessage(error, `SELECT expression ${item.text}`)])
      }
    })
    rows.push({ id: row.id, values, sortContext: ctx })
  }
  return { columns, outputColumns, outputMeta, rows }
}

// ---------------------------------------------------------------------------
// DISTINCT / ORDER BY
// ---------------------------------------------------------------------------

function assertSupportedOutputCollations(
  outputMeta: ReadonlyArray<ColumnMeta | undefined>,
  operation: string,
): void {
  for (const meta of outputMeta) {
    if (meta?.unsupportedCollation !== undefined) {
      throw new SimulationAbort([
        `${operation} uses column collation "${meta.unsupportedCollation}", which the visualizer cannot reproduce; only BINARY and NOCASE are supported.`,
      ])
    }
  }
}

function distinctStage(
  rows: ProjectedRow[],
  outputMeta: ReadonlyArray<ColumnMeta | undefined>,
  pushFine: (event: BuildEvent) => boolean,
): { unique: ProjectedRow[]; duplicates: ProjectedRow[] } {
  assertSupportedOutputCollations(outputMeta, 'DISTINCT')
  const seen = new Set<string>()
  const unique: ProjectedRow[] = []
  const duplicates: ProjectedRow[] = []
  for (const row of rows) {
    const key = rowKey(
      row.values.map((value, index) =>
        normalizeKeyValue(value, outputMeta[index]?.collation ?? 'BINARY'),
      ),
    )
    if (seen.has(key)) {
      duplicates.push(row)
      pushFine({
        type: 'DUPLICATE_DETECTED',
        stage: 'DISTINCT',
        description: `Row ${row.id} duplicates an earlier row and is removed by DISTINCT.`,
        payload: { rowId: row.id },
      })
      continue
    }
    seen.add(key)
    unique.push(row)
  }
  return { unique, duplicates }
}

/** Resolve an ORDER BY term into a key extractor for projected rows. */
function resolveSortKey(
  term: Expression,
  columns: string[],
  outputMeta: ReadonlyArray<ColumnMeta | undefined>,
): (row: ProjectedRow) => { value: unknown; collation: CollationName } {
  const collationForOutput = (index: number): CollationName => {
    const explicit = explicitCollationOf(term)
    if (explicit !== null) return explicit
    const meta = outputMeta[index]
    if (meta?.unsupportedCollation !== undefined) {
      throw new SimulationAbort([
        `ORDER BY uses column collation "${meta.unsupportedCollation}", which the visualizer cannot reproduce; only BINARY and NOCASE are supported.`,
      ])
    }
    return meta?.collation ?? 'BINARY'
  }

  // Ordinal reference: ORDER BY 1
  const target = term.kind === 'collate' ? term.operand : term
  if (target.kind === 'literal' && typeof target.value === 'number') {
    const ordinal = Math.trunc(target.value)
    if (ordinal < 1 || ordinal > columns.length) {
      throw new SimulationAbort([`ORDER BY ordinal ${ordinal} is outside the output column range.`])
    }
    return (row) => ({ value: row.values[ordinal - 1], collation: collationForOutput(ordinal - 1) })
  }

  // Column reference: match an output label first (alias or column name).
  if (target.kind === 'column') {
    const wanted = target.name.toLowerCase()
    const wantedTable = target.table?.toLowerCase() ?? null
    const index = columns.findIndex((label) => {
      const { table, name } = splitDisplayLabel(label)
      if (name.toLowerCase() !== wanted) return false
      if (wantedTable !== null && table !== null && table.toLowerCase() !== wantedTable) return false
      return true
    })
    if (index >= 0) {
      return (row) => ({ value: row.values[index], collation: collationForOutput(index) })
    }
  }

  // Fall back to evaluating the expression against the row's own
  // context (source row, or group representative + aggregates).
  return (row) => {
    try {
      return {
        value: evaluateExpression(term, row.sortContext),
        collation: collationOfExpression(term, row.sortContext),
      }
    } catch (error) {
      if (error instanceof SimulationAbort) throw error
      throw new SimulationAbort([
        `ORDER BY expression "${term.text}" cannot be resolved against the projected output or the source rows: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ])
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function snapshotOf(
  stage: StageSnapshot['stage'],
  label: string,
  columns: string[],
  rows: VisualizedRow[],
  removedRows: VisualizedRow[],
  explanation: string,
  truncated: boolean,
  groups: GroupSnapshot[] = [],
): StageSnapshot {
  const roles: StageSnapshot['roles'] = {}
  for (const row of rows) roles[row.id] = 'unchanged'
  for (const row of removedRows) {
    roles[row.id] = stage === 'LIMIT' ? 'skipped' : 'filtered'
  }
  return {
    stage,
    label,
    columns,
    rows,
    removedRows,
    roles,
    groups,
    explanation,
    inputRowCount: rows.length + removedRows.length,
    outputRowCount: rows.length,
    truncated,
  }
}

function toVisualized(rows: SimRow[]): VisualizedRow[] {
  return rows.map((row) => ({ id: row.id, values: [...row.values] }))
}

function toVisualizedProjected(rows: ProjectedRow[]): VisualizedRow[] {
  return rows.map((row) => ({ id: row.id, values: [...row.values] }))
}

// ---------------------------------------------------------------------------
// Nested query blocks
// ---------------------------------------------------------------------------

/**
 * State shared by one top-level simulation and the nested blocks it
 * evaluates. Nested results are cached and recorded once, so a scalar
 * subquery is never executed twice for the same outer query.
 */
interface CteRuntimeResult {
  blockId: string
  name: string
  columns: string[]
  columnMeta: ColumnMeta[]
  rows: unknown[][]
  /** True when the CTE's rows are not the complete relation. */
  incomplete: boolean
  /** Why the CTE is incomplete (its own cap and/or upstream CTEs). */
  incompleteReasons: string[]
}

interface CteDeclaration {
  name: string
  blockId: string
  /** Zero-based position in the WITH clause. */
  index: number
}

interface SimulationRuntime {
  nested: NestedQueryTrace[]
  depth: number
  cache: Map<string, unknown>
  /**
   * Ancestor query blocks, outermost → innermost. Used to classify
   * unqualified column references before a block runs.
   */
  scopeStack: QueryStructure[]
  /** CTE results visible at the current point in execution. */
  cteResults: Map<string, CteRuntimeResult>
  /** Every CTE declared by the root statement (for forward-ref errors). */
  cteDeclarations: Map<string, CteDeclaration>
  /** Number of CTEs that are visible right now (declaration order). */
  cteVisibility: number
  /**
   * Output metadata of every completed block, keyed by block id. Lets
   * CTE/subquery/compound consumers inherit column affinity and collation
   * without threading it through the public trace types.
   */
  outputMeta: Map<string, ColumnMeta[]>
}

/** A physical table or a CTE result, resolved unambiguously by name. */
interface ResolvedRelation {
  data: TableData
  /** The CTE block that produced the rows, or null for a physical table. */
  cte: CteRuntimeResult | null
  /** True when the relation's rows are not the complete result. */
  incomplete: boolean
  /** Why the relation is incomplete (empty for physical tables). */
  incompleteReasons: string[]
}

const MAX_SUBQUERY_DEPTH = 6

/**
 * Resolve a relation name with SQLite-like scoping:
 * 1. a visible CTE shadows a physical table of the same name;
 * 2. otherwise the physical database table is used;
 * 3. a name that only a not-yet-visible CTE declares is reported as a
 *    forward/self reference instead of silently reading the wrong data.
 */
function resolveRelation(
  name: string,
  getTableData: (name: string) => TableData | null,
  runtime: SimulationRuntime,
): ResolvedRelation | null {
  const key = name.toLowerCase()
  const cte = runtime.cteResults.get(key)
  if (cte !== undefined) {
    return {
      data: {
        columns: [...cte.columns],
        rows: cte.rows.map((row) => [...row]),
        columnMeta: [...cte.columnMeta],
      },
      cte,
      incomplete: cte.incomplete,
      incompleteReasons: [...cte.incompleteReasons],
    }
  }
  const physical = getTableData(name)
  if (physical !== null) {
    return { data: physical, cte: null, incomplete: false, incompleteReasons: [] }
  }
  const declaration = runtime.cteDeclarations.get(key)
  if (declaration !== undefined && declaration.index >= runtime.cteVisibility) {
    throw new SimulationAbort([
      declaration.index === runtime.cteVisibility
        ? `CTE "${declaration.name}" refers to itself. Recursive CTEs (WITH RECURSIVE) are not supported.`
        : `CTE "${declaration.name}" is referenced before it is defined. Forward references to later CTEs are not supported.`,
    ])
  }
  return null
}

function selectSummaryOf(structure: QueryStructure): string {
  if (structure.selectAll) return '*'
  const summary = structure.selectItems.map((item) => item.text).join(', ')
  return summary.length > 48 ? `${summary.slice(0, 45)}…` : summary
}

/** Stage where a source relation's rows are consumed (never a name guess). */
function dependencyStageOf(table: TraceSourceTable): VisualizedStage {
  if (table.consumerStage !== null && table.consumerStage !== undefined) return table.consumerStage
  return table.role === 'cte' ? 'FROM' : 'SELECT'
}

/**
 * Direct dependencies of one block, derived only from the block's own
 * resolved source relations. A `cte` source is the CTE block that
 * produced the rows; a `subquery` source is a nested block (usually a
 * scalar) evaluated before this block's pipeline. Physical tables are
 * never dependencies, and names are irrelevant: ids come from resolution.
 */
function directDependenciesOf(trace: VisualizationTrace): NestedQueryDependency[] {
  const dependencies: NestedQueryDependency[] = []
  const seen = new Set<string>()
  for (const table of trace.sourceTables) {
    if (table.queryId === undefined) continue
    if (table.role !== 'cte' && table.role !== 'subquery') continue
    const stage = dependencyStageOf(table)
    const key = `${table.queryId}|${stage}`
    if (seen.has(key)) continue
    seen.add(key)
    dependencies.push({ blockId: table.queryId, stage })
  }
  return dependencies
}

/** Duplicate dependency references (same block and consuming stage) collapse. */
function dedupeDependencies(dependencies: NestedQueryDependency[]): NestedQueryDependency[] {
  const seen = new Set<string>()
  const unique: NestedQueryDependency[] = []
  for (const dependency of dependencies) {
    const key = `${dependency.blockId}|${dependency.stage}|${dependency.viaBlockId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(dependency)
  }
  return unique
}

/** Every nested block below `parentId`, direct and transitive. */
function descendantBlocksOf(runtime: SimulationRuntime, parentId: string): NestedQueryTrace[] {
  const descendants: NestedQueryTrace[] = []
  const visit = (id: string): void => {
    for (const block of runtime.nested) {
      if (block.parentId !== id) continue
      descendants.push(block)
      visit(block.id)
    }
  }
  visit(parentId)
  return descendants
}

/**
 * Dependencies of a CTE block: its own direct CTE/scalar reads plus
 * dependencies reached through scalar subqueries nested inside its body.
 * The transitive form records the scalar block that performed the read,
 * so the graph can wire the exact intermediate block as well.
 */
function cteDependenciesOf(
  trace: VisualizationTrace,
  runtime: SimulationRuntime,
  blockId: string,
): NestedQueryDependency[] {
  const dependencies = directDependenciesOf(trace)
  for (const descendant of descendantBlocksOf(runtime, blockId)) {
    for (const dependency of descendant.dependencies ?? []) {
      if (dependency.blockId === blockId) continue
      const stage = descendant.consumingStage ?? dependency.stage
      dependencies.push({
        blockId: dependency.blockId,
        stage,
        viaBlockId: descendant.id,
        referenceStage: dependency.referenceStage ?? dependency.stage,
      })
    }
  }
  return dedupeDependencies(dependencies)
}

/**
 * Evaluate one nested query block through the same logical simulator and
 * record its real snapshots. The returned value matches how the block is
 * consumed:
 * - scalar: first row / first column (empty → NULL)
 * - in:     the list of first-column values (exactly one column required)
 * - exists: whether the block produced any row (column count is irrelevant)
 */
function evaluateSubquery(
  subquery: SubqueryExpr,
  getTableData: (name: string) => TableData | null,
  options: SimulationOptions,
  runtime: SimulationRuntime,
): unknown {
  if (runtime.cache.has(subquery.id)) return runtime.cache.get(subquery.id)

  // Correlation is decided against the real column names of this block
  // and its ancestors. Nothing is simulated for a correlated block: an
  // explicit unsupported reason is better than a misleading trace.
  const relationData = (name: string): TableData | null =>
    resolveRelation(name, getTableData, runtime)?.data ?? null
  const correlation = detectCorrelation(subquery.query, runtime.scopeStack, relationData)
  if (correlation.correlated) {
    throw new SimulationAbort([
      `Correlated subqueries are not visualizable yet: ${subquery.text} reads a column from the outer query${
        correlation.reference !== undefined ? ` (${correlation.reference})` : ''
      }.`,
    ])
  }

  if (runtime.depth >= MAX_SUBQUERY_DEPTH) {
    throw new SimulationAbort(['Subqueries are nested too deeply to visualize.'])
  }
  runtime.depth += 1
  let outcome: SimulationOutcome
  try {
    outcome = simulateQuery(
      structureText(subquery.query),
      subquery.query,
      getTableData,
      options,
      undefined,
      runtime,
    )
  } finally {
    runtime.depth -= 1
  }

  if (!outcome.ok) {
    throw new SimulationAbort(
      outcome.reasons.map((reason) => `Subquery ${subquery.text}: ${reason}`),
    )
  }
const trace = outcome.trace
  if (subquery.usage !== 'exists' && trace.finalColumns.length !== 1) {
    throw new SimulationAbort([
      `${
        subquery.usage === 'in' ? 'IN' : 'Scalar'
      } subquery ${subquery.text} returns ${trace.finalColumns.length} columns; SQLite requires exactly one.`,
    ])
  }

  let value: unknown
  let note: string | undefined
  if (subquery.usage === 'exists') {
    value = trace.finalRows.length > 0
  } else if (subquery.usage === 'in') {
    value = trace.finalRows.map((row) => row.values[0] ?? null)
    if (trace.finalRows.length === 0) {
      note = 'The subquery returned no rows, so IN is false and NOT IN is true.'
    }
  } else {
    value = trace.finalRows[0]?.values[0] ?? null
    note =
      trace.finalRows.length === 0
        ? 'The subquery returned no rows, so SQLite uses NULL.'
        : trace.finalRows.length > 1
          ? `The subquery returned ${trace.finalRows.length} rows; SQLite uses the first row’s first column.`
          : undefined
  }

  runtime.cache.set(subquery.id, value)
  runtime.nested.push({
    id: subquery.query.id,
    kind: subquery.usage === 'in' ? 'in' : subquery.usage === 'exists' ? 'exists' : 'scalar',
    label: `${
      subquery.usage === 'in' ? 'IN' : subquery.usage === 'exists' ? 'EXISTS' : 'Scalar'
    } subquery · ${selectSummaryOf(subquery.query)}`,
    sql: structureText(subquery.query),
    stageSnapshots: trace.stageSnapshots,
    finalColumns: trace.finalColumns,
    finalRows: trace.finalRows,
    parentStage: subquery.parentStage,
    consumingStage: subquery.parentStage,
    parentId: subquery.query.parentId ?? undefined,
    depth: subquery.query.depth,
    correlated: subquery.correlated,
    note,
    // Nested playback uses the block's own real events. Each one is
    // tagged with the block id, so it can never activate outer stages.
    events: trace.events.map((event) => ({
      ...event,
      blockId: subquery.query.id,
    })),
    status: 'complete',
    unavailableReasons: [],
    truncated: trace.truncated,
    incomplete: trace.incomplete === true,
    incompleteReasons: [...(trace.incompleteReasons ?? [])],
    dependencies: directDependenciesOf(trace),
    hasDeterministicOrder: trace.hasDeterministicOrder,
  })
  return value
}

/** Evaluate every nested block used by a query structure, once each. */
function evaluateSubqueries(
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
  options: SimulationOptions,
  runtime: SimulationRuntime,
): { values: Map<string, unknown>; columnMeta: Map<string, ColumnMeta> } {
  const values = new Map<string, unknown>()
  const columnMeta = new Map<string, ColumnMeta>()
  for (const subquery of structure.subqueries) {
    values.set(
      subquery.id,
      evaluateSubquery(subquery, getTableData, options, runtime),
    )
    if (subquery.usage !== 'exists') {
      const meta = runtime.outputMeta.get(subquery.query.id)?.[0]
      if (meta !== undefined) columnMeta.set(subquery.id, meta)
    }
  }
  return { values, columnMeta }
}

/**
 * Evaluate every CTE of the root WITH clause, in declaration order.
 * Each CTE is simulated through the same SELECT pipeline; its real
 * output is registered so later CTEs and the outer query read it as a
 * relation. Results are recorded as `kind: 'cte'` nested blocks with
 * their own snapshots, events and dependency metadata.
 */
function evaluateCtes(
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
  options: SimulationOptions,
  runtime: SimulationRuntime,
): void {
  const declarations = new Map<string, CteDeclaration>()
  structure.ctes.forEach((cte, index) => {
    declarations.set(cte.name.toLowerCase(), {
      name: cte.name,
      blockId: cte.query.id,
      index,
    })
  })
  runtime.cteDeclarations = declarations

  structure.ctes.forEach((cte, index) => {
    // Only earlier CTEs are in scope while this body runs.
    runtime.cteVisibility = index
    const sql = structureText(cte.query)
    const outcome = simulateQuery(sql, cte.query, getTableData, options, undefined, runtime)
    if (!outcome.ok) {
      throw new SimulationAbort(
        outcome.reasons.map((reason) => `CTE "${cte.name}": ${reason}`),
      )
    }
    const trace = outcome.trace
    if (cte.columns !== null && cte.columns.length !== trace.finalColumns.length) {
      throw new SimulationAbort([
        `CTE "${cte.name}" declares ${cte.columns.length} column$({
          cte.columns.length === 1 ? '' : 's'
        }) but its SELECT produces ${trace.finalColumns.length}.`,
      ])
    }
    const columns = cte.columns !== null ? [...cte.columns] : [...trace.finalColumns]
    const rows = trace.finalRows.map((row) => ({ id: row.id, values: [...row.values] }))

    // Dependencies are the earlier CTE blocks (and nested scalar blocks)
    // this body actually read. Scalar descendants contribute transitive
    // dependencies too, so upstream tracing can follow them.
    const dependencies = cteDependenciesOf(trace, runtime, cte.query.id)

    runtime.cteResults.set(cte.name.toLowerCase(), {
      blockId: cte.query.id,
      name: cte.name,
      columns,
      columnMeta: columns.map(
        (_, index) => runtime.outputMeta.get(cte.query.id)?.[index] ?? UNKNOWN_COLUMN_META,
      ),
      rows: rows.map((row) => [...row.values]),
      incomplete: trace.incomplete === true,
      incompleteReasons: [...(trace.incompleteReasons ?? [])],
    })
    runtime.nested.push({
      id: cte.query.id,
      kind: 'cte',
      label: `CTE ${cte.name} · ${selectSummaryOf(cte.query)}`,
      sql,
      cteName: cte.name,
      cteColumns: cte.columns,
      stageSnapshots: trace.stageSnapshots,
      finalColumns: columns,
      finalRows: rows,
      parentStage: null,
      consumingStage: null,
      parentId: cte.query.parentId ?? undefined,
      depth: cte.query.depth,
      correlated: false,
      note:
        cte.columns !== null
          ? `Declared column list maps to ${cte.columns.join(', ')}.`
          : undefined,
      events: trace.events.map((event) => ({ ...event, blockId: cte.query.id })),
      status: 'complete',
      unavailableReasons: [],
      truncated: trace.truncated,
      incomplete: trace.incomplete === true,
      incompleteReasons: [...(trace.incompleteReasons ?? [])],
      hasDeterministicOrder: trace.hasDeterministicOrder,
      dependencies,
    })
    runtime.cteVisibility = index + 1
  })
  runtime.cteVisibility = structure.ctes.length
}

// ---------------------------------------------------------------------------
// Compound SELECT (set operations)
// ---------------------------------------------------------------------------

/** SQLite NULL-safe whole-row identity used by compound set operations. */
function compoundValueKey(
  values: unknown[],
  columnMeta: ReadonlyArray<ColumnMeta | undefined>,
): string {
  // NULLs compare equal for set-operation deduplication, integers and reals
  // of the same numeric value are equal, and different storage classes stay
  // distinct. The result columns' collations decide case folding.
  return rowKey(
    values.map((value, index) =>
      normalizeKeyValue(value, columnMeta[index]?.collation ?? 'BINARY'),
    ),
  )
}
interface DistinctCompoundFold {
  rows: VisualizedRow[]
  removedRows: VisualizedRow[]
  duplicates: VisualizedRow[]
  excludedCount: number
}

/** Fold INTERSECT or EXCEPT over two real branch relations. */
function foldDistinctCompoundRows(
  left: VisualizedRow[],
  right: VisualizedRow[],
  operator: 'INTERSECT' | 'EXCEPT',
  outputMeta: ReadonlyArray<ColumnMeta | undefined>,
  pushFine: (event: BuildEvent) => boolean,
): DistinctCompoundFold {
  const rows: VisualizedRow[] = []
  const removedRows: VisualizedRow[] = []
  const duplicates: VisualizedRow[] = []
  let excludedCount = 0

  const removeDuplicate = (row: VisualizedRow, input: string): void => {
    removedRows.push(row)
    duplicates.push(row)
    pushFine({
      type: 'DUPLICATE_DETECTED',
      stage: 'COMPOUND',
      description: `Row ${row.id} duplicates an earlier row in the ${input} and is removed by ${operator}.`,
      payload: { rowId: row.id },
    })
  }

  // Both sides are distinct relations for INTERSECT and EXCEPT. Record
  // right-side duplicates too instead of hiding them inside a lookup Set.
  const rightKeys = new Set<string>()
  for (const row of right) {
    const key = compoundValueKey(row.values, outputMeta)
    if (rightKeys.has(key)) {
      removeDuplicate(row, 'next branch')
      continue
    }
    rightKeys.add(key)
  }

  const leftKeys = new Set<string>()
  for (const row of left) {
    const key = compoundValueKey(row.values, outputMeta)
    if (leftKeys.has(key)) {
      removeDuplicate(row, 'accumulated left input')
      continue
    }
    leftKeys.add(key)

    const presentOnRight = rightKeys.has(key)
    const retained = operator === 'INTERSECT' ? presentOnRight : !presentOnRight
    if (retained) {
      rows.push(row)
      pushFine({
        type: 'ROW_ACCEPTED',
        stage: 'COMPOUND',
        description:
          operator === 'INTERSECT'
            ? `Row ${row.id} has an equal row in the next branch and is retained by INTERSECT.`
            : `Row ${row.id} is absent from the next branch and is retained by EXCEPT.`,
        payload: { rowId: row.id },
      })
      continue
    }

    removedRows.push(row)
    excludedCount += 1
    pushFine({
      type: 'ROW_FILTERED',
      stage: 'COMPOUND',
      description:
        operator === 'INTERSECT'
          ? `Row ${row.id} has no equal row in the next branch and is excluded by INTERSECT.`
          : `Row ${row.id} has an equal row in the next branch and is excluded by EXCEPT.`,
      payload: { rowId: row.id },
    })
  }

  return { rows, removedRows, duplicates, excludedCount }
}

/** Beginner-friendly explanation of one actual compound operation. */
function compoundOperationExplanation(
  operator: 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT',
  leftCount: number,
  rightCount: number,
  duplicateCount: number,
  excludedCount: number,
): string {
  const inputs = `Combined ${leftCount} accumulated left row${leftCount === 1 ? '' : 's'} with ${rightCount} row${rightCount === 1 ? '' : 's'} from the next branch.`
  if (operator === 'UNION ALL') {
    return `${inputs} UNION ALL kept every row, including duplicates.`
  }
  if (operator === 'UNION') {
    return `${inputs} UNION removed ${duplicateCount} duplicate row${duplicateCount === 1 ? '' : 's'} across the accumulated result; NULLs compare equal to NULLs.`
  }
  if (operator === 'INTERSECT') {
    return `${inputs} INTERSECT kept only distinct rows present in both inputs; it excluded ${excludedCount} non-matching left row${excludedCount === 1 ? '' : 's'} and removed ${duplicateCount} duplicate row${duplicateCount === 1 ? '' : 's'}. Corresponding NULL values compare equal.`
  }
  return `${inputs} EXCEPT kept only distinct left rows absent from the next input; it excluded ${excludedCount} matching left row${excludedCount === 1 ? '' : 's'} and removed ${duplicateCount} duplicate row${duplicateCount === 1 ? '' : 's'}. Corresponding NULL values compare equal.`
}

/**
 * Simulate a compound statement: every SELECT branch runs through the
 * ordinary pipeline as an independent query block, then the branches are
 * folded left-to-right into the shared COMPOUND stage.
 *
 * SQLite semantics implemented here:
 * - compound operators are left-associative, so `A UNION B UNION ALL C`
 *   is `(A UNION B) UNION ALL C`;
 * - UNION removes duplicate rows across the whole accumulated result,
 *   UNION ALL keeps every row, and INTERSECT / EXCEPT produce distinct
 *   rows using NULL-safe whole-row comparison;
 * - trailing ORDER BY / LIMIT belong to the compound result, not to the
 *   last branch.
 */
function simulateCompoundQuery(
  sql: string,
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
  options: SimulationOptions,
  capability?: VisualizationCapability,
  runtimeIn?: SimulationRuntime,
): SimulationOutcome {
  const compound = structure.compound
  if (compound === null) {
    return { ok: false, reasons: ['Internal error: the query has no compound branches.'] }
  }
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const nestedRun = runtimeIn !== undefined
  const runtime: SimulationRuntime =
    runtimeIn ?? {
      nested: [],
      depth: 0,
      cache: new Map(),
      scopeStack: [],
      cteResults: new Map(),
      cteDeclarations: new Map(),
      cteVisibility: 0,
      outputMeta: new Map(),
    }
  const fineEvents: BuildEvent[] = []
  let fineGrainedBudget = maxEvents
  let currentCompoundOperationId: string | undefined
  const pushFine = (event: BuildEvent): boolean => {
    if (fineGrainedBudget <= 0) return false
    fineEvents.push({ ...event, compoundOperationId: currentCompoundOperationId })
    fineGrainedBudget--
    return true
  }
  let scopePushed = false

  try {
    // The root WITH clause is evaluated once and is visible to every
    // branch, exactly as SQLite scopes it across the compound.
    if (!nestedRun && structure.ctes.length > 0) {
      evaluateCtes(structure, getTableData, options, runtime)
    }
    runtime.scopeStack.push(structure)
    scopePushed = true

    const branchRows: VisualizedRow[][] = []
    const branchIncompleteReasons: string[] = []
    let columns: string[] | null = null
    let columnsMeta: ColumnMeta[] | null = null
    let anyBranchTruncated = false

    compound.branches.forEach((branch, index) => {
      if (runtime.depth >= MAX_SUBQUERY_DEPTH) {
        throw new SimulationAbort(['Compound queries are nested too deeply to visualize.'])
      }
      const branchSql = structureText(branch.query)
      runtime.depth += 1
      let outcome: SimulationOutcome
      try {
        outcome = simulateQuery(branchSql, branch.query, getTableData, options, undefined, runtime)
      } finally {
        runtime.depth -= 1
      }
      if (!outcome.ok) {
        throw new SimulationAbort(
          outcome.reasons.map((reason) => `Compound branch ${index + 1}: ${reason}`),
        )
      }
      const trace = outcome.trace
      if (columns === null) {
        columns = [...trace.finalColumns]
        columnsMeta = trace.finalColumns.map(
          (_, index) => runtime.outputMeta.get(branch.query.id)?.[index] ?? UNKNOWN_COLUMN_META,
        )
      } else if (trace.finalColumns.length !== columns.length) {
        throw new SimulationAbort([
          `Compound SELECT branches must return the same number of columns: branch 1 returns ${columns.length}, branch ${index + 1} returns ${trace.finalColumns.length}.`,
        ])
      }
      const rows: VisualizedRow[] = trace.finalRows.map((row) => ({
        id: `${branch.query.id}:${row.id}`,
        values: [...row.values],
      }))
      branchRows.push(rows)
      anyBranchTruncated = anyBranchTruncated || trace.truncated === true
      if (trace.incomplete === true) {
        branchIncompleteReasons.push(
          `Branch ${index + 1} is incomplete${
            (trace.incompleteReasons ?? []).length > 0
              ? `: ${(trace.incompleteReasons ?? []).join('; ')}`
              : '.'
          }`,
        )
      }

      runtime.nested.push({
        id: branch.query.id,
        kind: 'compound',
        label: `Branch ${index + 1} · ${selectSummaryOf(branch.query)}`,
        sql: branchSql,
        stageSnapshots: trace.stageSnapshots,
        finalColumns: [...trace.finalColumns],
        finalRows: rows.map((row) => ({ id: row.id, values: [...row.values] })),
        parentStage: 'COMPOUND',
        consumingStage: 'COMPOUND',
        parentId: structure.id,
        depth: branch.query.depth,
        correlated: false,
        setOperator: branch.operator,
        note:
          branch.operator === null
            ? 'The first branch establishes the compound result.'
            : `${branch.operator} combines this branch with the result so far.`,
        events: trace.events.map((event) => ({
          ...event,
          blockId: branch.query.id,
        })),
        status: 'complete',
        unavailableReasons: [],
        truncated: trace.truncated,
        incomplete: trace.incomplete === true,
        incompleteReasons: [...(trace.incompleteReasons ?? [])],
        dependencies: directDependenciesOf(trace),
        hasDeterministicOrder: trace.hasDeterministicOrder,
      })
    })

    if (columns === null) {
      throw new SimulationAbort(['A compound SELECT has no branches to visualize.'])
    }

    // --- fold the branches left-to-right ---------------------------------
    let rows: VisualizedRow[] = [...(branchRows[0] ?? [])]
    const operationTraces: CompoundOperationTrace[] = []
    const operationIncompleteReasons: string[] = []
    let anyOperationTruncated = false
    const operationCount = branchRows.length - 1
    for (let index = 1; index < branchRows.length; index++) {
      const branch = compound.branches[index]
      if (branch === undefined) continue
      const operator = branch.operator ?? 'UNION'
      const operationId = index === operationCount ? undefined : `COMPOUND-${index}`
      currentCompoundOperationId = operationId
      const leftInput = rows
      const incoming = branchRows[index] ?? []
      let operationRemoved: VisualizedRow[] = []
      let operationDuplicates: VisualizedRow[] = []
      let excludedCount = 0
      if (operator !== 'UNION ALL') {
        assertSupportedOutputCollations(columnsMeta ?? [], operator)
      }

      if (operator === 'UNION ALL') {
        rows = [...rows, ...incoming]
      } else if (operator === 'INTERSECT' || operator === 'EXCEPT') {
        const folded = foldDistinctCompoundRows(rows, incoming, operator, columnsMeta ?? [], pushFine)
        rows = folded.rows
        operationRemoved = folded.removedRows
        operationDuplicates = folded.duplicates
        excludedCount = folded.excludedCount
      } else {
        // UNION deduplicates the whole accumulated result, not just the
        // incoming branch: `A UNION ALL B UNION C` removes duplicates that
        // A/B themselves introduced. SQLite keeps the first representative
        // within each input; a distinct right representative supersedes an
        // equal left one (observable when NOCASE folds different spellings).
        const deduped: VisualizedRow[] = []
        const positions = new Map<string, number>()
        const removeDuplicate = (row: VisualizedRow): void => {
          operationRemoved.push(row)
          operationDuplicates.push(row)
          pushFine({
            type: 'DUPLICATE_DETECTED',
            stage: 'COMPOUND',
            description: `Row ${row.id} duplicates another row in the compound result and is removed by ${operator}.`,
            payload: { rowId: row.id },
          })
        }
        for (const row of rows) {
          const key = compoundValueKey(row.values, columnsMeta ?? [])
          if (positions.has(key)) {
            removeDuplicate(row)
            continue
          }
          positions.set(key, deduped.length)
          deduped.push(row)
        }
        const rightKeys = new Set<string>()
        for (const row of incoming) {
          const key = compoundValueKey(row.values, columnsMeta ?? [])
          if (rightKeys.has(key)) {
            removeDuplicate(row)
            continue
          }
          rightKeys.add(key)
          const existing = positions.get(key)
          if (existing === undefined) {
            positions.set(key, deduped.length)
            deduped.push(row)
            continue
          }
          const replaced = deduped[existing]
          if (replaced !== undefined) removeDuplicate(replaced)
          deduped[existing] = row
        }
        rows = deduped
      }

      const operationTruncated = rows.length > maxRows
      if (operationTruncated) {
        anyOperationTruncated = true
        operationIncompleteReasons.push(
          `${operator} step ${index} was capped at ${maxRows} of ${rows.length} rows for visualization; SQLite combines every row.`,
        )
      }
      const snapshot = snapshotOf(
        'COMPOUND',
        operationCount === 1
          ? `${operator} · ${compound.branches.length} branches`
          : `${operator} · step ${index} of ${operationCount}`,
        columns,
        operationTruncated ? rows.slice(0, maxRows) : rows,
        operationRemoved,
        compoundOperationExplanation(
          operator,
          leftInput.length,
          incoming.length,
          operationDuplicates.length,
          excludedCount,
        ),
        operationTruncated,
      )
      snapshot.inputRowCount = leftInput.length + incoming.length
      for (const row of operationDuplicates) snapshot.roles[row.id] = 'duplicated'
      if (operationId !== undefined) snapshot.compoundOperationId = operationId
      if (operationTruncated) {
        snapshot.incomplete = true
        snapshot.incompleteReasons = [
          `${operator} step ${index} output was capped for visualization.`,
        ]
      }
      operationTraces.push({
        id: operationId ?? 'COMPOUND',
        operator,
        rightBranchIndex: index,
        rightBlockId: branch.query.id,
        leftRows: leftInput.map((row) => ({ id: row.id, values: [...row.values] })),
        rightRows: incoming.map((row) => ({ id: row.id, values: [...row.values] })),
        snapshot,
      })
    }
    currentCompoundOperationId = undefined

    // --- display cap ------------------------------------------------------
    let truncated = false
    const incompleteReasons = uniqueReasons([
      ...branchIncompleteReasons,
      ...operationIncompleteReasons,
    ])
    if (rows.length > maxRows) {
      incompleteReasons.push(
        `The compound result was capped at ${maxRows} of ${rows.length} rows for visualization; SQLite combines every row.`,
      )
      rows = rows.slice(0, maxRows)
      truncated = true
    }

    const operators = compound.branches
      .slice(1)
      .map((branch) => branch.operator ?? 'UNION')
    const operatorSummary = [...new Set(operators)].join(' / ')
    const compoundSnapshot = operationTraces[operationTraces.length - 1]?.snapshot
    if (compoundSnapshot === undefined) {
      throw new SimulationAbort(['A compound SELECT has no operations to visualize.'])
    }

    // --- compound ORDER BY ------------------------------------------------
    let finalRows: VisualizedRow[] = rows
    let orderSnapshot: StageSnapshot | null = null
    let hasDeterministicOrder = false
    if (structure.orderBy.length > 0) {
      const comparators = structure.orderBy.map((term) => ({
        extractor: resolveSortKey(term.expression, columns as string[], columnsMeta ?? []),
        descending: term.direction === 'DESC',
      }))
      const projected: ProjectedRow[] = finalRows.map((row) => ({
        id: row.id,
        values: [...row.values],
        sortContext: contextOf(
          columns as string[],
          row.values,
          undefined,
          undefined,
          columnsMeta ?? [],
        ),
      }))
      const indexed = projected.map((row, index) => ({ row, index }))
      indexed.sort((a, b) => {
        for (const comparator of comparators) {
          const left = comparator.extractor(a.row)
          const right = comparator.extractor(b.row)
          const result = sortCompare(left.value, right.value, comparator.descending, left.collation)
          if (result !== 0) return result
        }
        return a.index - b.index
      })
      hasDeterministicOrder =
        indexed.length <= 1 ||
        indexed.every((entry, index) => {
          if (index === 0) return true
          const previous = indexed[index - 1]
          if (previous === undefined) return true
          return comparators.some((comparator) => {
            const left = comparator.extractor(previous.row)
            const right = comparator.extractor(entry.row)
            return sortCompare(left.value, right.value, false, left.collation) !== 0
          })
        })
      indexed.forEach((entry, newIndex) => {
        if (entry.index !== newIndex) {
          pushFine({
            type: 'ROW_SORTED',
            stage: 'ORDER_BY',
            description: `Row ${entry.row.id} moves from position ${entry.index + 1} to ${newIndex + 1}.`,
            payload: { rowId: entry.row.id, fromIndex: entry.index, toIndex: newIndex },
          })
        }
      })
      finalRows = indexed.map((entry) => ({
        id: entry.row.id,
        values: [...entry.row.values],
      }))
      orderSnapshot = snapshotOf(
        'ORDER_BY',
        `ORDER BY ${structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', ')}`,
        columns,
        finalRows,
        [],
        `ORDER BY rearranged all ${finalRows.length} compound rows. SQLite sorts NULLs first ascending (last descending); ties keep a stable order.`,
        truncated,
      )
    }

    // --- compound LIMIT / OFFSET -----------------------------------------
    let limitSnapshot: StageSnapshot | null = null
    if (structure.limit !== null) {
      const offset = structure.limit.offset
      const limit = structure.limit.limit
      const skipped = finalRows.slice(0, offset)
      const selected = finalRows.slice(offset, offset + limit)
      for (const row of skipped) {
        pushFine({
          type: 'ROW_SKIPPED',
          stage: 'LIMIT',
          description: `Row ${row.id} is skipped by OFFSET ${offset}.`,
          payload: { rowId: row.id },
        })
      }
      for (const row of selected) {
        pushFine({
          type: 'ROW_SELECTED',
          stage: 'LIMIT',
          description: `Row ${row.id} is selected within LIMIT ${limit}.`,
          payload: { rowId: row.id },
        })
      }
      limitSnapshot = snapshotOf(
        'LIMIT',
        structure.limit.text,
        columns,
        selected,
        skipped,
        `LIMIT ${limit}${offset > 0 ? ` after skipping OFFSET ${offset}` : ''} keeps ${selected.length} of ${finalRows.length} compound rows — this is the final result set.`,
        truncated,
      )
      finalRows = selected
    }

    const stageSnapshots: StageSnapshot[] = [compoundSnapshot]
    if (orderSnapshot !== null) stageSnapshots.push(orderSnapshot)
    if (limitSnapshot !== null) stageSnapshots.push(limitSnapshot)
    const timelineSnapshots = operationTraces.map((operation) => operation.snapshot)
    if (orderSnapshot !== null) timelineSnapshots.push(orderSnapshot)
    if (limitSnapshot !== null) timelineSnapshots.push(limitSnapshot)
    for (const snapshot of timelineSnapshots) {
      if (snapshot.blockId === undefined) snapshot.blockId = structure.id
    }

    const incomplete =
      incompleteReasons.length > 0 ||
      anyBranchTruncated ||
      anyOperationTruncated ||
      branchIncompleteReasons.length > 0
    if (incomplete) {
      const reasons = uniqueReasons(incompleteReasons)
      for (const snapshot of timelineSnapshots) {
        snapshot.incomplete = true
        snapshot.incompleteReasons = [...reasons]
      }
    }

    const events: BuildEvent[] = [
      {
        type: 'QUERY_STARTED',
        stage: null,
        description: `Visualizing the logical execution of: ${sql.trim()}`,
      },
    ]
    for (const snapshot of timelineSnapshots) {
      for (const event of fineEvents) {
        if (
          event.stage === snapshot.stage &&
          event.compoundOperationId === snapshot.compoundOperationId
        ) {
          events.push(event)
        }
      }
      events.push({
        type: 'STAGE_COMPLETED',
        stage: snapshot.stage,
        compoundOperationId: snapshot.compoundOperationId,
        description: `${snapshot.stage} completed: ${snapshot.outputRowCount} row${snapshot.outputRowCount === 1 ? '' : 's'} out.`,
        snapshot,
      })
    }
    events.push({
      type: 'QUERY_VISUALIZATION_COMPLETED',
      stage: null,
      description: `Logical simulation finished with ${finalRows.length} row${finalRows.length === 1 ? '' : 's'}.`,
    })

    const serialized: VisualizationEvent[] = events.map((event, index) => ({
      id: `${nestedRun ? `${structure.id}-` : ''}evt${index + 1}`,
      type: event.type,
      description: event.description,
      stage: event.stage,
      blockId: structure.id,
      compoundOperationId: event.compoundOperationId,
      payload: event.payload,
      snapshot: event.snapshot,
    }))

    const stages = stageSnapshots.map((snapshot) => snapshot.stage)
    const trace: VisualizationTrace = {
      query: sql,
      statementType: structure.statementType,
      capability:
        capability ?? {
          supported: true,
          supportedStages: stages,
          unsupportedFeatures: [],
          warnings: [],
          detected: [
            {
              kind: 'compound',
              detail: `${compound.branches.length} branches · ${operatorSummary}`,
            },
          ],
          isReadOnly: true,
          hasAggregation: compound.branches.some((branch) => branch.query.aggregates.length > 0),
          hasJoin: compound.branches.some((branch) => branch.query.joins.length > 0),
          estimatedComplexity: truncated ? 'large' : 'small',
        },
      stages,
      events: serialized,
      stageSnapshots,
      sourceTables: [],
      nestedQueries: [...runtime.nested].sort(
        (a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')),
      ),
      compound: {
        branches: compound.branches.map((branch) => ({
          blockId: branch.query.id,
          operator: branch.operator,
        })),
        operations: operationTraces,
      },
      rootBlockId: structure.id,
      totalSteps: serialized.length,
      finalRows,
      finalColumns: [...columns],
      hasDeterministicOrder,
      truncated: truncated || anyBranchTruncated || anyOperationTruncated,
      incomplete,
      incompleteReasons: uniqueReasons(incompleteReasons),
    }
    runtime.outputMeta.set(structure.id, columnsMeta ?? [])
    return { ok: true, trace }
  } catch (error) {
    if (error instanceof SimulationAbort) {
      return { ok: false, reasons: error.reasons }
    }
    return { ok: false, reasons: [`Simulation failed unexpectedly: ${String(error)}`] }
  } finally {
    if (scopePushed) runtime.scopeStack.pop()
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Simulate a single SELECT statement through the logical pipeline.
 * `getTableData` must return the real table contents (columns + rows).
 * Pass the capability from `analyzeCapability` to attach it to the trace.
 */
export function simulateQuery(
  sql: string,
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
  options: SimulationOptions = {},
  capability?: VisualizationCapability,
  runtimeIn?: SimulationRuntime,
): SimulationOutcome {
  if (structure.compound !== null) {
    return simulateCompoundQuery(sql, structure, getTableData, options, capability, runtimeIn)
  }
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const nestedRun = runtimeIn !== undefined
  const runtime: SimulationRuntime =
    runtimeIn ?? {
      nested: [],
      depth: 0,
      cache: new Map(),
      scopeStack: [],
      cteResults: new Map(),
      cteDeclarations: new Map(),
      cteVisibility: 0,
      outputMeta: new Map(),
    }
  const events: BuildEvent[] = []
  let fineGrainedBudget = maxEvents

  const pushFine = (event: BuildEvent): boolean => {
    if (fineGrainedBudget <= 0) return false
    events.push(event)
    fineGrainedBudget--
    return true
  }

  let scopePushed = false
  try {
    // CTEs are independent inputs: evaluate them before the outer query
    // becomes a scope, so a CTE body can never be mistaken for a
    // correlated subquery of the root.
    if (!nestedRun && structure.ctes.length > 0) {
      evaluateCtes(structure, getTableData, options, runtime)
    }

    // This block is now the innermost scope; nested blocks resolve
    // unqualified column references against it before running.
    runtime.scopeStack.push(structure)
    scopePushed = true

    // Nested blocks are inputs: evaluate them once against real data
    // before the outer pipeline starts, and never per visible row.
    const subqueryResults = evaluateSubqueries(structure, getTableData, options, runtime)
    const subqueryValues = subqueryResults.values

    const fromRelation = resolveRelation(structure.from.name, getTableData, runtime)
    if (fromRelation === null) {
      throw new SimulationAbort([
        `Table "${structure.from.name}" does not exist in the current database.`,
      ])
    }
    const joinRelations = structure.joins.map((join) => {
      const relation = resolveRelation(join.table.name, getTableData, runtime)
      if (relation === null) {
        throw new SimulationAbort([
          `Table "${join.table.name}" does not exist in the current database.`,
        ])
      }
      return relation
    })

    const state = loadFrom(structure, fromRelation, maxRows)
    state.subqueryValues = subqueryValues
    state.subqueryColumnMeta = subqueryResults.columnMeta

    // Nested blocks are inputs too. If one was capped or read an
    // incomplete CTE, this block's rows are also incomplete, even when
    // its own FROM/JOIN data fit under the display cap.
    for (const subquery of structure.subqueries) {
      const nested = runtime.nested.find((entry) => entry.id === subquery.query.id)
      if (nested?.incomplete !== true) continue
      state.incomplete = true
      state.incompleteReasons = uniqueReasons([
        ...state.incompleteReasons,
        `Reads incomplete nested block ${nested.label}: ${(nested.incompleteReasons ?? []).join('; ')}`,
      ])
    }
    const baseRows = [...state.rows]
    const baseLabels = [...state.displayLabels]

    // Real source-table metadata for the flow graph (capped previews,
    // full row counts — straight from the loaded tables). A relation that
    // resolves to a CTE keeps the CTE's block id so the graph wires the
    // block's real output to the stage that consumes it.
    const SOURCE_PREVIEW_LIMIT = 12
    const sourceTables: TraceSourceTable[] = []
    const fromData = fromRelation.data
    sourceTables.push({
      name: fromRelation.cte?.name ?? structure.from.name,
      alias: structure.from.alias,
      columns: [...fromData.columns],
      rowCount: fromData.rows.length,
      realRowCount:
        fromRelation.cte !== null && fromRelation.incomplete ? null : fromData.rows.length,
      previewRows: fromData.rows.slice(0, SOURCE_PREVIEW_LIMIT).map((values, index) => ({
        id: `${structure.from.name}#${index + 1}`,
        values: [...values],
      })),
      role: fromRelation.cte !== null ? 'cte' : 'from',
      joinType: null,
      on: null,
      incomplete: fromRelation.incomplete,
      incompleteReasons: [...fromRelation.incompleteReasons],
      ...(fromRelation.cte !== null
        ? { queryId: fromRelation.cte.blockId, consumerStage: 'FROM' as VisualizedStage }
        : {}),
    })

    events.push({
      type: 'QUERY_STARTED',
      stage: null,
      description: `Visualizing the logical execution of: ${sql.trim()}`,
    })
    events.push({
      type: 'SOURCE_TABLE_LOADED',
      stage: 'FROM',
      description: `FROM ${structure.from.name}: loaded ${baseRows.length} row${baseRows.length === 1 ? '' : 's'}${
        state.truncated ? ` (capped at ${maxRows} for visualization — SQLite still processes the full table)` : ''
      }.`,
    })

    // FROM snapshot (the original dataset, before any join).
    const fromSnapshot = snapshotOf(
      'FROM',
      `FROM ${structure.from.name}`,
      baseLabels,
      toVisualized(baseRows),
      [],
      `The FROM clause loads the rows of ${structure.from.name}. Every following stage works on this dataset.`,
      state.truncated,
    )

    // JOIN
    const joinText = structure.joins.map((join) => join.text).join(' ')
    let joinSnapshot: StageSnapshot | null = null
    if (structure.joins.length > 0) {
      const leftRowCount = state.rows.length
      const joinTableCounts = joinRelations.map((relation) => relation.data.rows.length)
      joinStage(state, structure, joinRelations, maxRows)
      // Snapshot the joined rows *now*: later stages (WHERE, GROUP BY)
      // replace state.rows, and the JOIN node must keep showing what the
      // join itself produced.
      joinSnapshot = {
        ...snapshotOf(
          'JOIN',
          joinText,
          state.displayLabels,
          toVisualized(state.rows),
          [],
          `${structure.joins.length === 1 ? 'The join' : `${structure.joins.length} joins`} matched ${leftRowCount} row${leftRowCount === 1 ? '' : 's'} against ${joinTableCounts.join(' + ')} lookup row${joinTableCounts.reduce((a, b) => a + b, 0) === 1 ? '' : 's'}, producing ${state.rows.length} combined row${state.rows.length === 1 ? '' : 's'}.`,
          state.truncated,
        ),
        // Rows entering the join from the left-hand side (the right-hand
        // tables are inputs too, but a single count cannot express both).
        inputRowCount: leftRowCount,
      }
      structure.joins.forEach((join, joinIndex) => {
        const relation = joinRelations[joinIndex]
        if (relation === undefined) return
        sourceTables.push({
          name: relation.cte?.name ?? join.table.name,
          alias: join.table.alias,
          columns: [...relation.data.columns],
          rowCount: relation.data.rows.length,
          realRowCount:
            relation.cte !== null && relation.incomplete ? null : relation.data.rows.length,
          previewRows: relation.data.rows.slice(0, SOURCE_PREVIEW_LIMIT).map((values, index) => ({
            id: `${join.table.name}#${index + 1}`,
            values: [...values],
          })),
          role: relation.cte !== null ? 'cte' : 'join',
          joinType: join.type,
          on: join.on?.text ?? null,
          incomplete: relation.incomplete,
          incompleteReasons: [...relation.incompleteReasons],
          ...(relation.cte !== null
            ? { queryId: relation.cte.blockId, consumerStage: 'JOIN' as VisualizedStage }
            : {}),
        })
      })
    }

    // Nested query blocks are logical inputs to the outer pipeline. Their
    // rows come from their own simulated snapshots, not the outer result.
    for (const subquery of structure.subqueries) {
      const nested = runtime.nested.find((entry) => entry.id === subquery.query.id)
      if (nested === undefined) continue
      sourceTables.push({
        name: nested.label,
        alias: null,
        columns: nested.finalColumns,
        rowCount: nested.finalRows.length,
        realRowCount: nested.incomplete === true ? null : nested.finalRows.length,
        previewRows: nested.finalRows.slice(0, SOURCE_PREVIEW_LIMIT).map((row) => ({
          id: row.id,
          values: [...row.values],
        })),
        role: 'subquery',
        joinType: null,
        on: null,
        queryId: nested.id,
        consumerStage: subquery.parentStage,
        incomplete: nested.incomplete === true,
        incompleteReasons: [...(nested.incompleteReasons ?? [])],
      })
    }

    // WHERE
    const beforeWhere = state.rows.length
    const whereRemoved = whereStage(state, structure, pushFine)
    const whereSnapshot =
      structure.where !== null
        ? snapshotOf(
            'WHERE',
            `WHERE ${structure.where.text}`,
            state.displayLabels,
            toVisualized(state.rows),
            toVisualized(whereRemoved),
            `WHERE evaluated ${beforeWhere} rows against ${structure.where.text}; ${state.rows.length} remain. A condition that evaluates to UNKNOWN (NULL) is treated as false, exactly like SQLite.`,
            state.truncated,
          )
        : null

    // GROUP BY (and implicit grouping when aggregates are present).
    const beforeGroup = state.rows.length
    groupStage(state, structure, pushFine)
    const groupSnapshot =
      state.groups !== undefined
        ? {
            ...snapshotOf(
              'GROUP_BY',
              state.groupByExpressions !== undefined && state.groupByExpressions.length > 0
                ? `GROUP BY ${state.groupByExpressions.map((expr) => expr.text).join(', ')}`
                : 'Implicit grouping (whole table)',
              ['(groups)'],
              state.rows.map((row) => ({ id: row.id, values: row.keyValues ?? [] })),
              [],
              state.groupByExpressions !== undefined && state.groupByExpressions.length > 0
                ? `GROUP BY collected ${beforeGroup} row${beforeGroup === 1 ? '' : 's'} into ${state.groups.length} group${state.groups.length === 1 ? '' : 's'} by matching key values; aggregates are computed per group.`
                : `With aggregates and no GROUP BY, SQLite treats the whole result as one group (${beforeGroup} row${beforeGroup === 1 ? '' : 's'}).`,
              state.truncated,
              state.groups,
            ),
            // The snapshot's rows are the groups themselves, so the derived
            // input count would be the group count. The honest number of
            // rows entering the grouping is the pre-group row count.
            inputRowCount: beforeGroup,
            outputRowCount: state.groups.length,
          }
        : null

    // HAVING
    const beforeHaving = state.rows.length
    const havingRemoved = havingStage(state, structure, pushFine)
    const havingSnapshot =
      structure.having !== null
        ? snapshotOf(
            'HAVING',
            `HAVING ${structure.having.text}`,
            ['(groups)'],
            state.rows.map((row) => ({ id: row.id, values: row.keyValues ?? [] })),
            toVisualized(havingRemoved),
            `HAVING removed ${beforeHaving - state.rows.length} of ${beforeHaving} group${beforeHaving === 1 ? '' : 's'} — unlike WHERE, it filters groups after aggregation.`,
            state.truncated,
            state.groups,
          )
        : null

    // SELECT projection
    const projection = projectRows(state, structure)
    const selectLabel = structure.selectAll
      ? 'SELECT *'
      : `SELECT ${structure.selectItems.map((item) => item.text).join(', ')}`
    const selectSnapshot = snapshotOf(
      'SELECT',
      selectLabel,
      projection.columns,
      toVisualizedProjected(projection.rows),
      [],
      `SELECT projects ${projection.columns.length} column${projection.columns.length === 1 ? '' : 's'} for each remaining row${state.groups !== undefined ? ' (one row per group)' : ''}, evaluating expressions and applying aliases.`,
      state.truncated,
    )

    // DISTINCT
    const distinctResult = structure.distinct
      ? distinctStage(projection.rows, projection.outputMeta, pushFine)
      : { unique: projection.rows, duplicates: [] as ProjectedRow[] }
    const distinctSnapshot = structure.distinct
      ? snapshotOf(
          'DISTINCT',
          'SELECT DISTINCT',
          projection.columns,
          toVisualizedProjected(distinctResult.unique),
          toVisualizedProjected(distinctResult.duplicates),
          `DISTINCT removed ${distinctResult.duplicates.length} duplicate row${distinctResult.duplicates.length === 1 ? '' : 's'}; ${distinctResult.unique.length} unique row${distinctResult.unique.length === 1 ? '' : 's'} remain.`,
          state.truncated,
        )
      : null

    // ORDER BY
    let finalRows = distinctResult.unique
    let orderSnapshot: StageSnapshot | null = null
    // The final order is only fully determined when the ORDER BY keys
    // separate every pair of rows — ties leave the order to SQLite.
    let hasDeterministicOrder = false
    if (structure.orderBy.length > 0) {
      const comparators = structure.orderBy.map((term) => ({
        extractor: resolveSortKey(term.expression, projection.columns, projection.outputMeta),
        descending: term.direction === 'DESC',
      }))
      const indexed = finalRows.map((row, index) => ({ row, index }))
      indexed.sort((a, b) => {
        for (const comparator of comparators) {
          const left = comparator.extractor(a.row)
          const right = comparator.extractor(b.row)
          const result = sortCompare(left.value, right.value, comparator.descending, left.collation)
          if (result !== 0) return result
        }
        return a.index - b.index // stable tie-break
      })
      hasDeterministicOrder =
        indexed.length <= 1 ||
        indexed.every((entry, index) => {
          if (index === 0) return true
          const previous = indexed[index - 1]
          if (previous === undefined) return true
          return comparators.some((comparator) => {
            const left = comparator.extractor(previous.row)
            const right = comparator.extractor(entry.row)
            return sortCompare(left.value, right.value, false, left.collation) !== 0
          })
        })
      const sorted = indexed.map((entry) => entry.row)
      indexed.forEach((entry, newIndex) => {
        if (entry.index !== newIndex) {
          pushFine({
            type: 'ROW_SORTED',
            stage: 'ORDER_BY',
            description: `Row ${entry.row.id} moves from position ${entry.index + 1} to ${newIndex + 1} (${structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', ')}).`,
            payload: { rowId: entry.row.id, fromIndex: entry.index, toIndex: newIndex },
          })
        }
      })
      finalRows = sorted
      orderSnapshot = snapshotOf(
        'ORDER_BY',
        `ORDER BY ${structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', ')}`,
        projection.columns,
        toVisualizedProjected(sorted),
        [],
        `ORDER BY rearranged all ${sorted.length} rows. SQLite sorts NULLs first ascending (last descending); ties keep a stable order.`,
        state.truncated,
      )
    }

    // LIMIT / OFFSET
    let limitSnapshot: StageSnapshot | null = null
    if (structure.limit !== null) {
      const offset = structure.limit.offset
      const limit = structure.limit.limit
      const skipped = finalRows.slice(0, offset)
      const selected = finalRows.slice(offset, offset + limit)
      for (const row of skipped) {
        pushFine({
          type: 'ROW_SKIPPED',
          stage: 'LIMIT',
          description: `Row ${row.id} is skipped by OFFSET ${offset}.`,
          payload: { rowId: row.id },
        })
      }
      for (const row of selected) {
        pushFine({
          type: 'ROW_SELECTED',
          stage: 'LIMIT',
          description: `Row ${row.id} is selected within LIMIT ${limit}.`,
          payload: { rowId: row.id },
        })
      }
      limitSnapshot = snapshotOf(
        'LIMIT',
        structure.limit.text,
        projection.columns,
        toVisualizedProjected(selected),
        toVisualizedProjected(skipped),
        `LIMIT ${limit}${offset > 0 ? ` after skipping OFFSET ${offset}` : ''} keeps ${selected.length} of ${finalRows.length} rows — this is the final result set.`,
        state.truncated,
      )
      finalRows = selected
    }

    // Assemble stage snapshots; STAGE_COMPLETED events carry them. Each
    // snapshot is tagged with its owning block so a stage name is never
    // ambiguous across nested blocks.
    const stageSnapshots: StageSnapshot[] = [fromSnapshot]
    if (joinSnapshot !== null) stageSnapshots.push(joinSnapshot)
    if (whereSnapshot !== null) stageSnapshots.push(whereSnapshot)
    if (groupSnapshot !== null) stageSnapshots.push(groupSnapshot)
    if (havingSnapshot !== null) stageSnapshots.push(havingSnapshot)
    stageSnapshots.push(selectSnapshot)
    if (distinctSnapshot !== null) stageSnapshots.push(distinctSnapshot)
    if (orderSnapshot !== null) stageSnapshots.push(orderSnapshot)
    if (limitSnapshot !== null) stageSnapshots.push(limitSnapshot)
    for (const snapshot of stageSnapshots) {
      if (snapshot.blockId === undefined) snapshot.blockId = structure.id
    }
    // Every snapshot in an incomplete block is a partial view, whether
    // the cap happened in this block or upstream. Snapshot-level flags
    // make the limitation visible in playback and the inspector.
    if (state.incomplete) {
      const reasons = uniqueReasons(state.incompleteReasons)
      for (const snapshot of stageSnapshots) {
        snapshot.incomplete = true
        snapshot.incompleteReasons = [...reasons]
      }
    }

    for (const snapshot of stageSnapshots) {
      events.push({
        type: 'STAGE_COMPLETED',
        stage: snapshot.stage,
        description: `${snapshot.stage} completed: ${snapshot.outputRowCount} row${snapshot.outputRowCount === 1 ? '' : 's'} out.`,
        snapshot,
      })
    }
    events.push({
      type: 'QUERY_VISUALIZATION_COMPLETED',
      stage: null,
      description: `Logical simulation finished with ${finalRows.length} row${finalRows.length === 1 ? '' : 's'}.`,
    })

    // Build the event timeline in execution order. Fine-grained row
    // events are generated while the pipeline runs, so they arrive
    // before any STAGE_COMPLETED. Grouping each stage's row events ahead
    // of its completion event makes sequential playback tell the real
    // story: intro → stage rows → stage snapshot → next stage.
    const orderedEvents: BuildEvent[] = []
    for (const event of events) {
      if (event.type === 'QUERY_STARTED' || event.type === 'SOURCE_TABLE_LOADED') {
        orderedEvents.push(event)
      }
    }
    const rowEventsByStage = new Map<VisualizedStage, BuildEvent[]>()
    for (const event of events) {
      if (event.stage === null || event.type === 'STAGE_COMPLETED') continue
      if (event.type === 'QUERY_STARTED' || event.type === 'SOURCE_TABLE_LOADED') continue
      if (event.type === 'QUERY_VISUALIZATION_COMPLETED') continue
      const bucket = rowEventsByStage.get(event.stage) ?? []
      bucket.push(event)
      rowEventsByStage.set(event.stage, bucket)
    }
    const completionByStage = new Map<VisualizedStage, BuildEvent>()
    for (const event of events) {
      if (event.type === 'STAGE_COMPLETED' && event.stage !== null) {
        completionByStage.set(event.stage, event)
      }
    }
    for (const snapshot of stageSnapshots) {
      orderedEvents.push(...(rowEventsByStage.get(snapshot.stage) ?? []))
      const completion = completionByStage.get(snapshot.stage)
      if (completion !== undefined) orderedEvents.push(completion)
    }
    const queryCompleted = events.find((event) => event.type === 'QUERY_VISUALIZATION_COMPLETED')
    // Keep anything not covered by a stage snapshot (defensive: no
    // current event type falls through) just before the final event.
    const included = new Set(orderedEvents)
    for (const event of events) {
      if (included.has(event) || event.type === 'QUERY_VISUALIZATION_COMPLETED') continue
      orderedEvents.push(event)
    }
    if (queryCompleted !== undefined) orderedEvents.push(queryCompleted)

    const serialized: VisualizationEvent[] = orderedEvents.map((event, index) => ({
      id: `${nestedRun ? `${structure.id}-` : ''}evt${index + 1}`,
      type: event.type,
      description: event.description,
      stage: event.stage,
      blockId: structure.id,
      payload: event.payload,
      snapshot: event.snapshot,
    }))

    const stages = stageSnapshots.map((snapshot) => snapshot.stage)
    const trace: VisualizationTrace = {
      query: sql,
      statementType: structure.statementType,
      capability:
        capability ?? {
          supported: true,
          supportedStages: stages,
          unsupportedFeatures: [],
          warnings: [],
          detected: [],
          isReadOnly: true,
          hasAggregation: structure.aggregates.length > 0,
          hasJoin: structure.joins.length > 0,
          estimatedComplexity: state.truncated ? 'large' : 'small',
        },
      stages,
      events: serialized,
      stageSnapshots,
      sourceTables,
      nestedQueries: [...runtime.nested].sort(
        (a, b) => Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')),
      ),
      rootBlockId: structure.id,
      totalSteps: serialized.length,
      finalRows: toVisualizedProjected(finalRows),
      finalColumns: projection.outputColumns,
      hasDeterministicOrder,
      truncated: state.truncated,
      incomplete: state.incomplete,
      incompleteReasons: uniqueReasons(state.incompleteReasons),
    }
    runtime.outputMeta.set(structure.id, projection.outputMeta.map((meta) => ({ ...meta })))
    return { ok: true, trace }
  } catch (error) {
    if (error instanceof SimulationAbort) {
      return { ok: false, reasons: error.reasons }
    }
    return { ok: false, reasons: [`Simulation failed unexpectedly: ${String(error)}`] }
  } finally {
    if (scopePushed) runtime.scopeStack.pop()
  }
}

/** Convenience wrapper: interpret then simulate the first statement. */
export function simulateSql(
  sql: string,
  statements: string[],
  getTableData: (name: string) => TableData | null,
  options: SimulationOptions = {},
): SimulationOutcome {
  const interpretation = interpretQuery(sql, statements)
  if (interpretation.structure === null) {
    return { ok: false, reasons: interpretation.unsupportedReasons }
  }
  if (interpretation.unsupportedReasons.length > 0) {
    // A structure was parsed but contains constructs we cannot
    // faithfully simulate — never visualize a partial interpretation.
    return { ok: false, reasons: interpretation.unsupportedReasons }
  }
  return simulateQuery(sql, interpretation.structure, getTableData, options)
}


