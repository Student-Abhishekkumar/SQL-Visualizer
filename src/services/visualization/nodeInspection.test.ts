import { describe, expect, it } from 'vitest'
import type { StageSnapshot, VisualizationTrace } from '../../types/visualization'
import { makeTrace, stageSnapshot } from '../../test/fixtures/visualization'
import { buildFlowGraph } from './graphBuilder'
import { inspectNode, inputSnapshotOf } from './nodeInspection'

function makeGroupTrace(): VisualizationTrace {
  const base = makeTrace()
  const group = (index: number): StageSnapshot['groups'][number] => ({
    index,
    key: `department ${index}`,
    keyValues: [index],
    rowIds: [`r${index}a`, `r${index}b`],
    aggregates: { 'COUNT(*)': 2 },
  })
  const member = (suffix: string): { id: string; values: unknown[] } => ({
    id: `r${suffix}`,
    values: [`person ${suffix}`, 50000],
  })
  return {
    ...base,
    stages: ['FROM', 'GROUP_BY', 'SELECT'],
    stageSnapshots: [
      { ...stageSnapshot('FROM', 4), rows: [member('1a'), member('1b'), member('2a'), member('2b')] },
      { ...stageSnapshot('GROUP_BY', 4), groups: [group(1), group(2)] },
      stageSnapshot('SELECT', 2),
    ],
  }
}

const graph = buildFlowGraph(makeTrace())
const groupGraph = buildFlowGraph(makeGroupTrace())

function node(g: typeof graph, id: string) {
  const found = g.nodes.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`missing node ${id}`)
  return found
}

describe('inspectNode', () => {
  it('describes a source table and lists its real preview rows', () => {
    const inspection = inspectNode(node(graph, 'src-0-e'), makeTrace())
    expect(inspection.header.operation).toBe('FROM')
    expect(inspection.overview.outputRows).toBe(8)
    expect(inspection.inputs).toHaveLength(0)
    expect(inspection.output?.rows).toHaveLength(6)
    expect(inspection.output?.columns).toEqual(['name', 'salary'])
  })

  it('resolves the input snapshot as the previous stage', () => {
    const trace = makeTrace()
    expect(inputSnapshotOf(trace, 'WHERE')?.stage).toBe('FROM')
    expect(inputSnapshotOf(trace, 'FROM')).toBeNull()
    expect(inputSnapshotOf(trace, null)).toBeNull()
  })

  it('gives an operation its input rows, output rows and filter condition', () => {
    const inspection = inspectNode(node(graph, 'op-WHERE'), makeTrace())
    expect(inspection.inputs[0]?.rows).toHaveLength(8)
    expect(inspection.output?.rows).toHaveLength(4)
    expect(inspection.details.filter).toBe('WHERE salary > 50000')
    expect(inspection.details.accepted).toBe(4)
    expect(inspection.details.rejected).toBe(4)
    expect(inspection.overview.inputRows).toBe(8)
    expect(inspection.overview.outputRows).toBe(4)
  })

  it('shows the real removed rows for a rejected branch', () => {
    const inspection = inspectNode(node(graph, 'branch-WHERE'), makeTrace())
    expect(inspection.output?.rows).toHaveLength(4)
    expect(inspection.details.rejected).toBe(4)
    expect(inspection.details.accepted).toBe(4)
  })

  it('resolves a group node against its real member rows and aggregates', () => {
    const inspection = inspectNode(node(groupGraph, 'group-GROUP_BY-1'), makeGroupTrace())
    expect(inspection.details.groupKeys).toEqual(['department 1'])
    expect(inspection.inputs[0]?.rows).toHaveLength(2)
    expect(inspection.output?.rows[0]?.values).toEqual(['COUNT(*)', 2])
  })

  it('resolves JOIN inputs from every real source table', () => {
    const joinTrace: VisualizationTrace = {
      ...makeTrace(),
      stages: ['FROM', 'JOIN', 'SELECT'],
      capability: { ...makeTrace().capability, hasJoin: true, supportedStages: ['FROM', 'JOIN', 'SELECT'] },
      stageSnapshots: [stageSnapshot('FROM', 8), stageSnapshot('JOIN', 8), stageSnapshot('SELECT', 8)],
      sourceTables: [
        makeTrace().sourceTables[0]!,
        {
          name: 'departments',
          alias: 'd',
          columns: ['id', 'department_name'],
          rowCount: 3,
          previewRows: [{ id: 'dept#1', values: [1, 'dept 1'] }],
          role: 'join',
          joinType: 'INNER JOIN',
          on: 'd.id = e.department_id',
        },
      ],
    }
    const joinGraph = buildFlowGraph(joinTrace)
    const inspection = inspectNode(node(joinGraph, 'op-JOIN'), joinTrace)
    expect(inspection.inputs).toHaveLength(2)
    expect(inspection.details.joins).toEqual([
      { table: 'departments', kind: 'INNER JOIN', on: 'd.id = e.department_id' },
    ])
  })

  it('gives the final node its input and real output rows', () => {
    const inspection = inspectNode(node(graph, 'final'), makeTrace())
    expect(inspection.header.operation).toBe('OUTPUT')
    expect(inspection.overview.outputRows).toBe(1)
    expect(inspection.output?.rows[0]?.values).toEqual(['person 1', 50000])
    expect(inspection.inputs[0]?.rows.length).toBeGreaterThan(0)
  })

  it('handles empty results and missing snapshots gracefully', () => {
    const empty: VisualizationTrace = {
      ...makeTrace(),
      stageSnapshots: [stageSnapshot('FROM', 0), stageSnapshot('WHERE', 0), stageSnapshot('SELECT', 0)],
      finalRows: [],
    }
    const emptyGraph = buildFlowGraph(empty)
    const inspection = inspectNode(node(emptyGraph, 'op-WHERE'), empty)
    expect(inspection.output?.rows).toHaveLength(0)
    expect(inspection.overview.outputRows).toBe(0)

    const synthetic = node(graph, 'op-WHERE')
    const withoutSnapshot = inspectNode({ ...synthetic, snapshot: undefined }, makeTrace())
    expect(withoutSnapshot.output).toBeNull()
    expect(withoutSnapshot.overview.outputRows).toBeNull()
  })
})
