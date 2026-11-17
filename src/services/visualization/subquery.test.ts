import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { analyzeCapability } from './capabilityAnalyzer'
import { buildFlowGraph } from './graphBuilder'
import { traceUpstreamPath } from './flowPath'
import { blocksOf } from './queryBlocks'
import { simulateQuery, type SimulationOptions, type TableData } from './simulator'

/**
 * IN / NOT IN / EXISTS / NOT EXISTS subqueries.
 *
 * Every block is simulated through the existing query-block machinery:
 * its real rows are evaluated once, registered as a nested input, and the
 * outer WHERE evaluates the operator with SQLite three-valued logic.
 */

const departments: TableData = {
  columns: ['id', 'department_name'],
  rows: [
    [1, 'Engineering'],
    [2, 'Sales'],
    [3, 'Marketing'],
  ],
}

const employees: TableData = {
  columns: ['id', 'name', 'department_id', 'salary'],
  rows: [
    [1, 'Ravi', 1, 62000],
    [2, 'Priya', 1, 48000],
    [3, 'Amit', 2, 55000],
    [4, 'Sara', 2, 75000],
    [5, 'John', null, 40000],
    [6, 'Nina', 3, 40000],
    [7, 'Omar', 3, 62000],
    [8, 'Lena', 3, 52000],
  ],
}

const TABLES: Record<string, TableData> = { employees, departments }
const getTableData = (name: string): TableData | null => TABLES[name] ?? null

function interpret(sql: string) {
  return interpretQuery(sql, [sql])
}

function run(sql: string, options: SimulationOptions = {}) {
  const interpretation = interpret(sql)
  expect(interpretation.unsupportedReasons).toEqual([])
  expect(interpretation.structure).not.toBeNull()
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData, options)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

function ids(trace: ReturnType<typeof run>): unknown[] {
  const column = trace.finalColumns.indexOf('id')
  expect(column).toBeGreaterThanOrEqual(0)
  return trace.finalRows.map((row) => row.values[column])
}

describe('IN / EXISTS interpretation', () => {
    it('interprets an IN subquery as its own block', () => {
      const interpretation = interpret(
        'SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments)',
      )
      const where = interpretation.structure?.where
      expect(where?.kind).toBe('in_subquery')
      if (where?.kind !== 'in_subquery') return
      expect(where.operator).toBe('IN')
      expect(where.subquery.usage).toBe('in')
      expect(where.subquery.query.blockKind).toBe('in')
      expect(interpretation.structure?.subqueries).toHaveLength(1)
      expect(analyzeCapability(interpretation).supported).toBe(true)
    })

    it('preserves NOT IN', () => {
      const where = interpret(
        'SELECT id FROM employees WHERE department_id NOT IN (SELECT id FROM departments)',
      ).structure?.where
      expect(where?.kind).toBe('in_subquery')
      if (where?.kind !== 'in_subquery') return
      expect(where.operator).toBe('NOT IN')
      expect(where.text).toMatch(/NOT IN/)
    })

    it('interprets EXISTS and NOT EXISTS as nested blocks', () => {
      const exists = interpret(
        'SELECT id FROM departments WHERE EXISTS (SELECT 1 FROM employees WHERE salary > 50000)',
      ).structure?.where
      expect(exists?.kind).toBe('exists_subquery')
      if (exists?.kind !== 'exists_subquery') return
      expect(exists.negated).toBe(false)
      expect(exists.subquery.usage).toBe('exists')
      expect(exists.subquery.query.blockKind).toBe('exists')

      const notExists = interpret(
        'SELECT id FROM departments WHERE NOT EXISTS (SELECT 1 FROM employees WHERE salary > 50000)',
      ).structure?.where
      expect(notExists?.kind).toBe('exists_subquery')
      if (notExists?.kind !== 'exists_subquery') return
      expect(notExists.negated).toBe(true)
    })
  })

  describe('IN / NOT IN simulation', () => {
    it('keeps rows that match the subquery and drops non-matches', () => {
      const trace = run(
        `SELECT id FROM employees
         WHERE department_id IN (SELECT id FROM departments WHERE id = 1)
         ORDER BY id`,
      )
      expect(ids(trace)).toEqual([1, 2])
    })

    it('handles NOT IN without treating it as a plain inverse (NULL left)', () => {
      const trace = run(
        `SELECT id FROM employees
         WHERE department_id NOT IN (SELECT id FROM departments WHERE id = 1)
         ORDER BY id`,
      )
      // John (department_id NULL) is UNKNOWN, so NOT IN excludes him.
      expect(ids(trace)).toEqual([3, 4, 6, 7, 8])
    })

    it('handles an empty subquery result', () => {
      const inTrace = run(
        'SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments WHERE id > 100)',
      )
      expect(ids(inTrace)).toEqual([])

      const notInTrace = run(
        `SELECT id FROM employees
         WHERE department_id NOT IN (SELECT id FROM departments WHERE id > 100)
         ORDER BY id`,
      )
      // SQLite short-circuits the empty set: NOT IN is TRUE even for a
      // NULL left operand.
      expect(ids(notInTrace)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })

    it('turns no-match plus a NULL member into UNKNOWN', () => {
      const trace = run(
        `SELECT id FROM employees
         WHERE department_id NOT IN (
           SELECT department_id FROM employees WHERE department_id IS NULL
         )`,
      )
      // The only member is NULL, so every comparison is UNKNOWN.
      expect(ids(trace)).toEqual([])
    })

    it('rejects a multi-column IN subquery with a clear reason', () => {
      const sql =
        'SELECT id FROM employees WHERE department_id IN (SELECT id, department_name FROM departments)'
      const interpretation = interpret(sql)
      const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reasons.join(' ')).toMatch(/requires exactly one/i)
    })
  })

  describe('EXISTS / NOT EXISTS simulation', () => {
    it('keeps every row when the subquery has rows', () => {
      const trace = run(
        `SELECT id FROM departments
         WHERE EXISTS (SELECT 1 FROM employees WHERE salary > 50000)
         ORDER BY id`,
      )
      expect(ids(trace)).toEqual([1, 2, 3])
    })

    it('drops every row when the subquery is empty', () => {
      const trace = run(
        'SELECT id FROM departments WHERE EXISTS (SELECT 1 FROM employees WHERE salary > 1000000)',
      )
      expect(ids(trace)).toEqual([])
    })

    it('inverts correctly for NOT EXISTS', () => {
      const trace = run(
        `SELECT id FROM departments
         WHERE NOT EXISTS (SELECT 1 FROM employees WHERE salary > 1000000)
         ORDER BY id`,
      )
      expect(ids(trace)).toEqual([1, 2, 3])
    })

    it('ignores the column count of an EXISTS subquery', () => {
      const trace = run(
        `SELECT id FROM departments
         WHERE EXISTS (SELECT id, name FROM employees WHERE id = 1)
         ORDER BY id`,
      )
      expect(ids(trace)).toEqual([1, 2, 3])
    })

    it('rejects correlated EXISTS rather than simulating it incorrectly', () => {
      const sql = `SELECT id FROM departments d
        WHERE EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.id)`
      const interpretation = interpret(sql)
      const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reasons.join(' ')).toMatch(/correlated/i)
    })

    it('rejects correlated IN rather than simulating it incorrectly', () => {
      const sql = `SELECT id FROM employees e
        WHERE e.department_id IN (SELECT d.id FROM departments d WHERE d.id = e.department_id)`
      const interpretation = interpret(sql)
      const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.reasons.join(' ')).toMatch(/correlated/i)
    })
  })

  describe('query-block and graph integration', () => {
    it('registers IN and EXISTS blocks with deterministic ids and kinds', () => {
      const trace = run(
        `SELECT id FROM employees
         WHERE department_id IN (SELECT id FROM departments)
           AND EXISTS (SELECT 1 FROM departments WHERE id = 1)`,
      )
      const blocks = trace.nestedQueries ?? []
      expect(blocks.map((block) => block.id)).toEqual(['q2', 'q3'])
      expect(blocks.map((block) => block.kind)).toEqual(['in', 'exists'])
      expect(blocks.every((block) => block.parentId === 'q1')).toBe(true)
      expect(blocksOf(trace).map((block) => block.id)).toEqual(['q1', 'q2', 'q3'])
    })

    it('wires the subquery source into the consuming WHERE operation', () => {
      const trace = run(
        'SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments)',
      )
      const graph = buildFlowGraph(trace)
      const source = graph.nodes.find((node) => node.table?.role === 'subquery')
      expect(source).toBeDefined()
      expect(source?.table?.consumerStage).toBe('WHERE')
      expect(
        graph.edges.some((edge) => edge.to === 'op-WHERE' && edge.from === source?.id),
      ).toBe(true)
    })

    it('lets an IN subquery read a CTE and wires the dependency edge', () => {
      const trace = run(
        `WITH dept AS (SELECT id FROM departments WHERE id >= 2)
         SELECT id FROM employees
         WHERE department_id IN (SELECT id FROM dept)
         ORDER BY id`,
      )
      expect(ids(trace)).toEqual([3, 4, 6, 7, 8])
      const cte = trace.nestedQueries!.find((block) => block.kind === 'cte')!
      const inBlock = trace.nestedQueries!.find((block) => block.kind === 'in')!
      expect(inBlock.dependencies).toEqual([{ blockId: cte.id, stage: 'FROM' }])

      const graph = buildFlowGraph(trace)
      expect(
        graph.edges.some(
          (edge) =>
            edge.kind === 'cte' &&
            edge.from === `${cte.id}-data-SELECT` &&
            edge.to === `${inBlock.id}-data-FROM`,
        ),
      ).toBe(true)

      // Upstream tracing from the outer WHERE reaches through the IN block
      // into the CTE it reads.
      const traced = traceUpstreamPath(graph, 'op-WHERE')
      expect(traced.nodeIds.has(`${inBlock.id}-data-FROM`)).toBe(true)
      expect(traced.nodeIds.has(`${cte.id}-data-SELECT`)).toBe(true)
    })

    it('propagates a display cap from the subquery into the outer trace', () => {
      const trace = run(
        'SELECT id FROM employees WHERE department_id IN (SELECT id FROM departments)',
        { maxRows: 2 },
      )
      const inBlock = trace.nestedQueries!.find((block) => block.kind === 'in')!
      expect(inBlock.truncated).toBe(true)
      expect(inBlock.incomplete).toBe(true)
      expect(trace.incomplete).toBe(true)
      expect(trace.incompleteReasons?.join(' ')).toMatch(/nested|incomplete/i)
    })
})