/**
 * Floating Node Inspector — data resolution.
 *
 * Turns a flow-graph node plus the immutable visualization trace into a
 * structured, ready-to-render inspection model. It never executes SQL
 * and never fabricates data: every table, count and clause comes from
 * the trace's real snapshots, source-table metadata and query text.
 *
 * Kept pure and separate from the canvas so both the popup and the
 * workspace can rely on one definition of "what data does this node
 * have", and so it can be unit tested without rendering.
 */

import type { FlowGraphNode } from '../../types/flowGraph'
import type {
  StageSnapshot,
  VisualizedRow,
  VisualizationTrace,
  VisualizedStage,
} from '../../types/visualization'
import { mapQueryClauses, spanOfStage } from './clauseMapper'

/** One real table of rows shown in the Input/Output tabs. */
export interface InspectionTable {
  /** Stable key for React and tests. */
  key: string
  /** Optional heading, e.g. the source-table name. */
  label?: string
  columns: string[]
  rows: VisualizedRow[]
  roles?: StageSnapshot['roles']
  /** Honest caption, e.g. a row cap or an empty-state reason. */
  note?: string
}

export interface InspectionJoin {
  table: string
  kind: string
  on: string | null
}

export interface NodeInspection {
  header: {
    title: string
    /** The SQL operation, e.g. "WHERE" or "FROM". */
    operation: string
    stage: VisualizedStage | null
    badge: string
  }
  overview: {
    description: string
    inputRows: number | null
    outputRows: number | null
  }
  inputs: InspectionTable[]
  output: InspectionTable | null
  details: {
    clause: string | null
    filter: string | null
    groupKeys: string[]
    sort: string | null
    joins: InspectionJoin[]
    accepted: number | null
    rejected: number | null
  }
}

/** The snapshot that fed the given stage (its upstream input snapshot). */
export function inputSnapshotOf(
  trace: VisualizationTrace,
  stage: VisualizedStage | null,
): StageSnapshot | null {
  if (stage === null) return null
  const index = trace.stageSnapshots.findIndex((snapshot) => snapshot.stage === stage)
  if (index <= 0) return null
  return trace.stageSnapshots[index - 1] ?? null
}

/** The real clause text of a stage, or null when it was not located. */
function clauseTextFor(trace: VisualizationTrace, stage: VisualizedStage): string | null {
  const span = spanOfStage(mapQueryClauses(trace.query), stage)
  if (span === null) return null
  const text = trace.query.slice(span.start, span.end).trim()
  return text === '' ? null : text
}

function tableFromSnapshot(
  snapshot: StageSnapshot,
  rows: VisualizedRow[],
  label: string,
  key: string,
): InspectionTable {
  return {
    key,
    label,
    columns: snapshot.columns,
    rows,
    roles: snapshot.roles,
  }
}

function joinsOf(trace: VisualizationTrace): InspectionJoin[] {
  return trace.sourceTables
    .filter((table) => table.role === 'join')
    .map((table) => ({
      table: table.name,
      kind: table.joinType ?? 'JOIN',
      on: table.on,
    }))
}

function snapshotDetails(trace: VisualizationTrace, snapshot: StageSnapshot | null) {
  const stage = snapshot?.stage ?? null
  const isFilterStage = stage === 'WHERE' || stage === 'HAVING'
  return {
    clause: stage !== null ? clauseTextFor(trace, stage) : null,
    filter: isFilterStage && stage !== null ? clauseTextFor(trace, stage) : null,
    groupKeys: stage === 'GROUP_BY' ? snapshot?.groups.map((group) => group.key) ?? [] : [],
    sort: stage === 'ORDER_BY' ? clauseTextFor(trace, stage) : null,
    joins: stage === 'JOIN' ? joinsOf(trace) : [],
    accepted: snapshot?.outputRowCount ?? null,
    rejected: snapshot?.removedRows.length ?? null,
  }
}

/**
 * Resolve the full inspection model for a node. Total: returns a useful
 * model for every node kind, with empty/absent sections instead of
 * throwing when data is unavailable.
 */
export function inspectNode(node: FlowGraphNode, trace: VisualizationTrace): NodeInspection {
  switch (node.kind) {
    case 'source': {
      const table = node.table
      const isFrom = table?.role === 'from'
      const title = `Source table: ${table?.name ?? node.label}`
      const operation = isFrom ? 'FROM' : (table?.joinType ?? 'JOIN')
      const inputs: InspectionTable[] = []
      const output: InspectionTable | null =
        table === undefined
          ? null
          : {
              key: 'source',
              columns: table.columns,
              rows: table.previewRows,
              note:
                table.previewRows.length < table.rowCount
                  ? `Preview of ${table.rowCount} real rows in the table.`
                  : undefined,
            }
      const joins: InspectionJoin[] =
        table !== undefined && table.role === 'join'
          ? [{ table: table.name, kind: table.joinType ?? 'JOIN', on: table.on }]
          : []
      return {
        header: {
          title,
          operation,
          stage: node.stage,
          badge: isFrom ? 'FROM' : 'JOIN',
        },
        overview: {
          description: isFrom
            ? 'This table is the query’s FROM source. It is loaded before any operation runs.'
            : `Joined with ${table?.joinType ?? 'JOIN'}${
                table?.on !== null && table?.on !== undefined ? ` ON ${table.on}` : ''
              }.`,
          inputRows: null,
          outputRows: table?.rowCount ?? null,
        },
        inputs,
        output,
        details: {
          clause: node.stage !== null ? clauseTextFor(trace, node.stage) : null,
          filter: null,
          groupKeys: [],
          sort: null,
          joins,
          accepted: null,
          rejected: null,
        },
      }
    }

    case 'operation': {
      const snapshot = node.snapshot ?? null
      const inputs: InspectionTable[] = []
      if (node.stage === 'JOIN') {
        for (const table of trace.sourceTables) {
          inputs.push({
            key: `join-${table.name}`,
            label: table.name,
            columns: table.columns,
            rows: table.previewRows,
          })
        }
      } else {
        const previous = inputSnapshotOf(trace, node.stage)
        if (previous !== null) {
          inputs.push(
            tableFromSnapshot(previous, previous.rows, `Input (${previous.stage})`, 'input'),
          )
        }
      }
      return {
        header: {
          title: `Operation: ${node.label}`,
          operation: node.stage ?? node.label,
          stage: node.stage,
          badge: node.stage ?? 'OP',
        },
        overview: {
          description: [node.detail, node.hint].filter(Boolean).join(' '),
          inputRows: snapshot?.inputRowCount ?? null,
          outputRows: snapshot?.outputRowCount ?? null,
        },
        inputs,
        output: snapshot !== null ? tableFromSnapshot(snapshot, snapshot.rows, 'Output', 'output') : null,
        details: snapshotDetails(trace, snapshot),
      }
    }

    case 'data': {
      const snapshot = node.snapshot ?? null
      const previous = inputSnapshotOf(trace, node.stage)
      return {
        header: {
          title: `Intermediate result: ${node.stage ?? node.label}`,
          operation: node.stage ?? node.label,
          stage: node.stage,
          badge: node.stage ?? 'DATA',
        },
        overview: {
          description: snapshot?.explanation ?? node.detail ?? '',
          inputRows: snapshot?.inputRowCount ?? null,
          outputRows: snapshot?.outputRowCount ?? null,
        },
        inputs:
          previous !== null
            ? [tableFromSnapshot(previous, previous.rows, `Input (${previous.stage})`, 'input')]
            : [],
        output:
          snapshot !== null
            ? tableFromSnapshot(snapshot, node.rows ?? snapshot.rows, 'Output', 'output')
            : null,
        details: snapshotDetails(trace, snapshot),
      }
    }

    case 'branch': {
      const snapshot = node.snapshot ?? null
      const description =
        snapshot?.stage === 'LIMIT'
          ? 'These rows were skipped by OFFSET and are not part of the final result.'
          : snapshot?.stage === 'DISTINCT'
            ? 'These projected rows duplicated an earlier row and were removed.'
            : node.hint ?? 'These rows did not pass the condition and did not continue.'
      return {
        header: {
          title: node.label,
          operation: node.stage ?? 'BRANCH',
          stage: node.stage,
          badge: 'removed',
        },
        overview: {
          description,
          inputRows: snapshot?.inputRowCount ?? null,
          outputRows: node.removedRows?.length ?? null,
        },
        inputs: [],
        output:
          snapshot !== null
            ? tableFromSnapshot(
                snapshot,
                node.removedRows ?? [],
                'Rejected / removed rows',
                'removed',
              )
            : null,
        details: {
          ...snapshotDetails(trace, snapshot),
          accepted: snapshot?.outputRowCount ?? null,
          rejected: node.removedRows?.length ?? null,
        },
      }
    }

    case 'group': {
      const group = node.group
      const previous = inputSnapshotOf(trace, node.stage)
      const members =
        group !== undefined && previous !== null
          ? previous.rows.filter((row) => group.rowIds.includes(row.id))
          : []
      const aggregates = Object.entries(group?.aggregates ?? {})
      const input: InspectionTable[] =
        previous !== null && members.length > 0
          ? [
              tableFromSnapshot(
                previous,
                members,
                `Member rows (from ${previous.stage})`,
                'members',
              ),
            ]
          : []
      const output: InspectionTable | null =
        aggregates.length > 0
          ? {
              key: 'aggregates',
              label: 'Aggregates',
              columns: ['aggregate', 'value'],
              rows: aggregates.map(([name, value], index) => ({
                id: `agg-${index}`,
                values: [name, value],
              })),
            }
          : null
      return {
        header: {
          title: `Group: ${group?.key ?? node.label}`,
          operation: node.stage ?? 'GROUP BY',
          stage: node.stage,
          badge: 'GROUP BY',
        },
        overview: {
          description:
            group !== undefined
              ? `${group.rowIds.length} row${group.rowIds.length === 1 ? '' : 's'} share this key.`
              : (node.detail ?? ''),
          inputRows: previous?.outputRowCount ?? null,
          outputRows: group?.rowIds.length ?? null,
        },
        inputs: input,
        output,
        details: {
          clause: node.stage !== null ? clauseTextFor(trace, node.stage) : null,
          filter: null,
          groupKeys: group !== undefined ? [group.key] : [],
          sort: null,
          joins: [],
          accepted: group?.rowIds.length ?? null,
          rejected: null,
        },
      }
    }

    default: {
      // final
      const lastSnapshot = trace.stageSnapshots[trace.stageSnapshots.length - 1] ?? null
      const lastStage = trace.stages[trace.stages.length - 1] ?? null
      return {
        header: {
          title: 'Final result',
          operation: 'OUTPUT',
          stage: lastStage,
          badge: 'result',
        },
        overview: {
          description:
            'The logical simulation’s final rows — validated against SQLite’s real result when the trace reports validation.',
          inputRows: lastSnapshot?.outputRowCount ?? null,
          outputRows: trace.finalRows.length,
        },
        inputs:
          lastSnapshot !== null
            ? [
                tableFromSnapshot(
                  lastSnapshot,
                  lastSnapshot.rows,
                  `Input (${lastSnapshot.stage})`,
                  'input',
                ),
              ]
            : [],
        output: {
          key: 'final',
          columns: node.snapshot?.columns ?? trace.finalColumns,
          rows: node.rows ?? trace.finalRows,
          note: trace.truncated ? 'Capped for display; the real result is complete.' : undefined,
        },
        details: {
          clause: lastStage !== null ? clauseTextFor(trace, lastStage) : null,
          filter: null,
          groupKeys: [],
          sort: lastStage === 'ORDER_BY' ? clauseTextFor(trace, lastStage) : null,
          joins: [],
          accepted: trace.finalRows.length,
          rejected: null,
        },
      }
    }
  }
}
