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

import { interpretQuery, type Expression, type QueryStructure, type SelectItem } from './astInterpreter'
import {
  compareNonNull,
  evaluateAggregate,
  evaluateCondition,
  evaluateExpression,
  EvaluationError,
  type EvalVerdict,
  type RowContext,
} from './expressionEvaluator'
import type {
  GroupSnapshot,
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
  rows: SimRow[]
  truncated: boolean
  /** Aggregates per group index, keyed by aggregate expression text. */
  aggregateValues?: Map<number, Record<string, unknown>>
  /** Groups produced by GROUP BY, kept in creation order. */
  groups?: GroupSnapshot[]
  groupByExpressions?: Expression[]
}

interface BuildEvent {
  type: VisualizationEvent['type']
  stage: VisualizationEvent['stage']
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

function stableValueKey(values: unknown[]): string {
  return `[${values.map((value) => `${typeof value}:${String(value)}`).join('|')}]`
}

function displayLabelForItem(item: SelectItem): string {
  if (item.alias !== null) return item.alias
  const expr = item.expression
  if (expr.kind === 'column') return expr.name
  return expr.text
}

/** Sort comparator implementing SQLite NULL ordering (NULLs smallest). */
function sortCompare(a: unknown, b: unknown, descending: boolean): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  let result: number
  if (aNull && bNull) result = 0
  else if (aNull) result = -1
  else if (bNull) result = 1
  else result = compareNonNull(a, b)
  if (result === 0) return 0
  return descending ? -result : result
}

function contextOf(labels: string[], values: unknown[], aggregates?: Record<string, unknown>): RowContext {
  return { columns: labels, values, aggregates }
}

function splitDisplayLabel(label: string): { table: string | null; name: string } {
  const dot = label.lastIndexOf('.')
  if (dot >= 0) return { table: label.slice(0, dot), name: label.slice(dot + 1) }
  return { table: null, name: label }
}

// ---------------------------------------------------------------------------
// FROM / JOIN
// ---------------------------------------------------------------------------

function loadFrom(
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
  maxRows: number,
): SimState {
  const base = structure.from
  const data = getTableData(base.name)
  if (data === null) {
    throw new SimulationAbort([`Table "${base.name}" does not exist in the current database.`])
  }
  const alias = base.alias ?? base.name
  const keptRows = data.rows.slice(0, maxRows)
  return {
    columnLabels: data.columns.map((column) => `${alias}.${column}`),
    displayLabels: [...data.columns],
    rows: keptRows.map((values, index) => ({
      id: `${base.name}#${index + 1}`,
      values: [...values],
    })),
    truncated: data.rows.length > keptRows.length,
  }
}

function joinStage(
  state: SimState,
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
  maxRows: number,
): void {
  for (const join of structure.joins) {
    const data = getTableData(join.table.name)
    if (data === null) {
      throw new SimulationAbort([`Table "${join.table.name}" does not exist in the current database.`])
    }
    const alias = join.table.alias ?? join.table.name
    const rightLabels = data.columns.map((column) => `${alias}.${column}`)
    const rightDisplay = data.columns.map((column) =>
      state.displayLabels.includes(column) ? `${alias}.${column}` : column,
    )

    const joinedRows: SimRow[] = []
    let truncated = state.truncated

    for (const leftRow of state.rows) {
      let matched = 0
      for (let r = 0; r < data.rows.length; r++) {
        const rightValues = data.rows[r]
        if (rightValues === undefined) continue
        if (joinedRows.length >= maxRows) {
          truncated = true
          break
        }
        if (join.on !== null) {
          let verdict: EvalVerdict
          try {
            verdict = evaluateCondition(join.on, {
              columns: [...state.columnLabels, ...rightLabels],
              values: [...leftRow.values, ...rightValues],
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

    state.columnLabels = [...state.columnLabels, ...rightLabels]
    state.displayLabels = [...state.displayLabels, ...rightDisplay]
    state.rows = joinedRows
    state.truncated = state.truncated || truncated
  }
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
  const kept: SimRow[] = []
  const filtered: SimRow[] = []
  for (const row of state.rows) {
    let verdict: EvalVerdict
    try {
      verdict = evaluateCondition(where, contextOf(state.columnLabels, row.values))
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
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const seen = new Set<string>()
  const contexts = rows.map((row) => contextOf(columnLabels, row.values))
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
  return contextOf(labels, values, aggregates)
}

function groupStage(
  state: SimState,
  structure: QueryStructure,
  pushFine: (event: BuildEvent) => boolean,
): void {
  const hasAggregates = structure.aggregates.length > 0
  const groupBy = structure.groupBy
  if (groupBy.length === 0 && !hasAggregates) return

  if (groupBy.length === 0) {
    // Implicit single group over all rows (SQLite behavior).
    const allRows = [...state.rows]
    const aggregateValues = computeAggregates(allRows, structure, state.columnLabels)
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
  for (const row of state.rows) {
    const keyValues: unknown[] = []
    for (const expr of groupBy) {
      try {
        keyValues.push(evaluateExpression(expr, contextOf(state.columnLabels, row.values)))
      } catch (error) {
        throw new SimulationAbort([evaluationMessage(error, 'GROUP BY expression')])
      }
    }
    const key = stableValueKey(keyValues)
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
    const aggregateValues = computeAggregates(bucket.rows, structure, state.columnLabels)
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
  const kept: SimRow[] = []
  const removed: SimRow[] = []
  for (const row of state.rows) {
    let verdict: EvalVerdict
    try {
      verdict = evaluateCondition(having, groupContext(state, row))
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

function projectRows(state: SimState, structure: QueryStructure): {
  columns: string[]
  rows: ProjectedRow[]
} {
  const columns: string[] = structure.selectAll
    ? [...state.displayLabels]
    : structure.selectItems.map((item) => displayLabelForItem(item))

  const rows: ProjectedRow[] = []
  for (const row of state.rows) {
    const ctx =
      row.groupIndex !== undefined
        ? groupContext(state, row)
        : contextOf(state.columnLabels, row.values)

    const values: unknown[] = structure.selectAll
      ? [...row.values]
      : []
    if (!structure.selectAll) {
      for (const item of structure.selectItems) {
        try {
          values.push(evaluateExpression(item.expression, ctx))
        } catch (error) {
          throw new SimulationAbort([evaluationMessage(error, `SELECT expression ${item.text}`)])
        }
      }
    }
    rows.push({ id: row.id, values, sortContext: ctx })
  }
  return { columns, rows }
}

// ---------------------------------------------------------------------------
// DISTINCT / ORDER BY
// ---------------------------------------------------------------------------

function distinctStage(
  rows: ProjectedRow[],
  pushFine: (event: BuildEvent) => boolean,
): { unique: ProjectedRow[]; duplicates: ProjectedRow[] } {
  const seen = new Set<string>()
  const unique: ProjectedRow[] = []
  const duplicates: ProjectedRow[] = []
  for (const row of rows) {
    const key = stableValueKey(row.values)
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
): (row: ProjectedRow) => unknown | null {
  // Ordinal reference: ORDER BY 1
  if (term.kind === 'literal' && typeof term.value === 'number') {
    const ordinal = Math.trunc(term.value)
    if (ordinal < 1 || ordinal > columns.length) {
      throw new SimulationAbort([`ORDER BY ordinal ${ordinal} is outside the output column range.`])
    }
    return (row) => row.values[ordinal - 1]
  }

  // Column reference: match an output label first (alias or column name).
  if (term.kind === 'column') {
    const wanted = term.name.toLowerCase()
    const wantedTable = term.table?.toLowerCase() ?? null
    const index = columns.findIndex((label) => {
      const { table, name } = splitDisplayLabel(label)
      if (name.toLowerCase() !== wanted) return false
      if (wantedTable !== null && table !== null && table.toLowerCase() !== wantedTable) return false
      return true
    })
    if (index >= 0) return (row) => row.values[index]
  }

  // Fall back to evaluating the expression against the row's own
  // context (source row, or group representative + aggregates).
  return (row) => {
    try {
      return evaluateExpression(term, row.sortContext)
    } catch {
      throw new SimulationAbort([
        `ORDER BY expression "${term.text}" cannot be resolved against the projected output or the source rows.`,
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
): SimulationOutcome {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS
  const events: BuildEvent[] = []
  let fineGrainedBudget = maxEvents

  const pushFine = (event: BuildEvent): boolean => {
    if (fineGrainedBudget <= 0) return false
    events.push(event)
    fineGrainedBudget--
    return true
  }

  try {
    const state = loadFrom(structure, getTableData, maxRows)
    const baseRows = [...state.rows]
    const baseLabels = [...state.displayLabels]

    // Real source-table metadata for the flow graph (capped previews,
    // full row counts — straight from the loaded tables).
    const SOURCE_PREVIEW_LIMIT = 12
    const sourceTables: TraceSourceTable[] = []
    const fromData = getTableData(structure.from.name)
    if (fromData !== null) {
      sourceTables.push({
        name: structure.from.name,
        alias: structure.from.alias,
        columns: [...fromData.columns],
        rowCount: fromData.rows.length,
        previewRows: fromData.rows.slice(0, SOURCE_PREVIEW_LIMIT).map((values, index) => ({
          id: `${structure.from.name}#${index + 1}`,
          values: [...values],
        })),
        role: 'from',
        joinType: null,
        on: null,
      })
    }

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
      const joinTableCounts = structure.joins.map(
        (join) => getTableData(join.table.name)?.rows.length ?? 0,
      )
      joinStage(state, structure, getTableData, maxRows)
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
      for (const join of structure.joins) {
        const joinData = getTableData(join.table.name)
        if (joinData === null) continue
        sourceTables.push({
          name: join.table.name,
          alias: join.table.alias,
          columns: [...joinData.columns],
          rowCount: joinData.rows.length,
          previewRows: joinData.rows.slice(0, SOURCE_PREVIEW_LIMIT).map((values, index) => ({
            id: `${join.table.name}#${index + 1}`,
            values: [...values],
          })),
          role: 'join',
          joinType: join.type,
          on: join.on?.text ?? null,
        })
      }
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
      ? distinctStage(projection.rows, pushFine)
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
        extractor: resolveSortKey(term.expression, projection.columns),
        descending: term.direction === 'DESC',
      }))
      const indexed = finalRows.map((row, index) => ({ row, index }))
      indexed.sort((a, b) => {
        for (const comparator of comparators) {
          const result = sortCompare(
            comparator.extractor(a.row),
            comparator.extractor(b.row),
            comparator.descending,
          )
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
          return comparators.some(
            (comparator) =>
              sortCompare(
                comparator.extractor(previous.row),
                comparator.extractor(entry.row),
                false,
              ) !== 0,
          )
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

    // Assemble stage snapshots; STAGE_COMPLETED events carry them.
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
      id: `evt${index + 1}`,
      type: event.type,
      description: event.description,
      stage: event.stage,
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
      totalSteps: serialized.length,
      finalRows: toVisualizedProjected(finalRows),
      finalColumns: projection.columns,
      hasDeterministicOrder,
      truncated: state.truncated,
    }
    return { ok: true, trace }
  } catch (error) {
    if (error instanceof SimulationAbort) {
      return { ok: false, reasons: error.reasons }
    }
    return { ok: false, reasons: [`Simulation failed unexpectedly: ${String(error)}`] }
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


