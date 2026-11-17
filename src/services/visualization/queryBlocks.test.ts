import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { simulateQuery, type TableData } from './simulator'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { foldEvents } from '../../store/visualizationStore'
import { ROOT_BLOCK_ID, blockEvents, stageKeyFor } from './queryBlocks'

/**
 * Nested-block identity, determinism and block-scoped activation.
 *
 * Two scalar subqueries in one WHERE must receive distinct ids, expose a
 * correct parent, and never collide in graph node ids or playback state.
 */

const employees: TableData = {
  columns: ['id', 'name', 'salary', 'age'],
  rows: [
    [1, 'Ravi', 62000, 30],
    [2, 'Priya', 48000, 26],
    [3, 'Amit', 55000, null],
    [4, 'Sara', 75000, 34],
  ],
}

const TABLES: Record<string, TableData> = { employees }
const getTableData = (name: string): TableData | null => TABLES[name] ?? null

function run(sql: string) {
  const interpretation = interpretQuery(sql, [sql])
  if (interpretation.structure === null) {
    throw new Error(interpretation.unsupportedReasons.join('; '))
  }
  return simulateQuery(sql, interpretation.structure, getTableData)
}

const TWO_SUBQUERIES =
  'SELECT name FROM employees WHERE salary > (SELECT AVG(salary) FROM employees WHERE salary > 1000) AND age > (SELECT MIN(age) FROM employees WHERE age > 10)'

describe('query blocks — identity', () => {
  it('assigns deterministic ids, kinds, parents and consuming stages', () => {
    const outcome = run(TWO_SUBQUERIES)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const nested = outcome.trace.nestedQueries ?? []
    expect(nested).toHaveLength(2)
    expect(nested.map((block) => block.id)).toEqual(['q2', 'q3'])
    expect(outcome.trace.rootBlockId).toBe(ROOT_BLOCK_ID)
    for (const block of nested) {
      expect(block.kind).toBe('scalar')
      expect(block.parentId).toBe(ROOT_BLOCK_ID)
      expect(block.depth).toBe(1)
      expect(block.consumingStage).toBe('WHERE')
      expect(block.parentStage).toBe('WHERE')
    }
  })

  it('produces identical block ids and snapshots on repeated runs', () => {
    const first = run(TWO_SUBQUERIES)
    const second = run(TWO_SUBQUERIES)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.trace.nestedQueries).toEqual(second.trace.nestedQueries)
  })

  it('tags snapshots and events with their owning block', () => {
    const outcome = run(TWO_SUBQUERIES)
    if (!outcome.ok) throw new Error('simulation failed')
    for (const block of outcome.trace.nestedQueries ?? []) {
      expect(block.stageSnapshots.length).toBeGreaterThan(0)
      expect(block.stageSnapshots.every((snapshot) => snapshot.blockId === block.id)).toBe(true)
      expect(block.events?.length ?? 0).toBeGreaterThan(0)
      expect(block.events?.every((event) => event.blockId === block.id)).toBe(true)
    }
  })

  it('keeps event ids unique across blocks', () => {
    const outcome = run(TWO_SUBQUERIES)
    if (!outcome.ok) throw new Error('simulation failed')
    const ids = (outcome.trace.nestedQueries ?? []).flatMap((block) =>
      (block.events ?? []).map((event) => event.id),
    )
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^q[23]-evt\d+$/.test(id))).toBe(true)
  })
})

describe('query blocks — graph identity', () => {
  it('never lets two blocks share a graph node id', () => {
    const outcome = run(TWO_SUBQUERIES)
    if (!outcome.ok) throw new Error('simulation failed')
    const graph = buildFlowGraph(outcome.trace)
    const ids = graph.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('op-WHERE')
    expect(ids).toContain('data-WHERE')
    expect(ids).toContain('q2-op-WHERE')
    expect(ids).toContain('q3-op-WHERE')
    expect(ids).toContain('q2-op-SELECT')
    expect(ids).toContain('q3-op-SELECT')
  })

  it('connects each nested subgraph to its own source node', () => {
    const outcome = run(TWO_SUBQUERIES)
    if (!outcome.ok) throw new Error('simulation failed')
    const graph = buildFlowGraph(outcome.trace)
    for (const block of outcome.trace.nestedQueries ?? []) {
      const last = block.stageSnapshots[block.stageSnapshots.length - 1]
      expect(last).toBeDefined()
      const dataId = `${block.id}-data-${last!.stage}`
      expect(graph.nodes.some((node) => node.id === dataId)).toBe(true)
      expect(graph.edges.some((edge) => edge.from === dataId)).toBe(true)
    }
  })
})

describe('query blocks — scoped activation', () => {
  const outcome = run(TWO_SUBQUERIES)
  if (!outcome.ok) throw new Error('simulation failed')
  const graph = buildFlowGraph(outcome.trace)

  it('activates only the requested block’s stage', () => {
    const inner = deriveFlowState(graph, new Set(), 'q2:WHERE', false)
    expect(inner.nodes['q2-op-WHERE']).toBe('active')
    expect(inner.nodes['op-WHERE']).not.toBe('active')
  })

  it('does not complete the outer WHERE when only an inner WHERE completed', () => {
    const state = deriveFlowState(graph, new Set(['q2:WHERE']), null, false)
    expect(state.nodes['q2-op-WHERE']).toBe('completed')
    expect(state.nodes['op-WHERE']).toBe('pending')
    expect(state.nodes['data-WHERE']).toBe('hidden')
  })

  it('does not complete an inner WHERE when only the outer WHERE completed', () => {
    const state = deriveFlowState(graph, new Set(['WHERE']), null, false)
    expect(state.nodes['op-WHERE']).toBe('completed')
    expect(state.nodes['q2-op-WHERE']).toBe('pending')
    expect(state.nodes['q2-data-WHERE']).toBe('hidden')
  })

  it('produces block-scoped keys when folding nested events', () => {
    const nested = outcome.trace.nestedQueries?.[0]
    expect(nested).toBeDefined()
    const events = blockEvents(outcome.trace, 'q2')
    expect(events.length).toBeGreaterThan(0)
    const view = foldEvents(events, events.length - 1, ROOT_BLOCK_ID, 'q2')
    expect(view.blockId).toBe('q2')
    expect(view.completedStageKeys.length).toBeGreaterThan(0)
    expect(view.completedStageKeys.every((key) => key.startsWith('q2:'))).toBe(true)
    // The root timeline never carries inner-stage keys.
    const rootView = foldEvents(outcome.trace.events, outcome.trace.events.length - 1, ROOT_BLOCK_ID)
    expect(rootView.completedStageKeys.some((key) => key.startsWith('q2:'))).toBe(false)
  })

  it('keeps root stage keys bare so single-query behavior is unchanged', () => {
    expect(stageKeyFor(null, 'WHERE')).toBe('WHERE')
    expect(stageKeyFor(ROOT_BLOCK_ID, 'WHERE', ROOT_BLOCK_ID)).toBe('WHERE')
    expect(stageKeyFor('q2', 'WHERE', ROOT_BLOCK_ID)).toBe('q2:WHERE')
  })
})
