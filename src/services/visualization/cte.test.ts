import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { analyzeCapability } from './capabilityAnalyzer'
import { buildFlowGraph, deriveFlowState } from './graphBuilder'
import { inspectNode } from './nodeInspection'
import { ROOT_BLOCK_ID, blockEvents, blocksOf } from './queryBlocks'
import { traceUpstreamPath } from './flowPath'
import { simulateQuery, type SimulationOptions, type TableData } from './simulator'
import { foldEvents } from '../../store/visualizationStore'

/**
 * Non-recursive CTE blocks.
 *
 * Each WITH definition is an independent query block with a deterministic
 * id, its own snapshots/events and an explicit dependency on the earlier
 * CTEs it reads. The outer query consumes the CTE's real simulated rows,
 * never a name-matched guess.
 */

const employees: TableData = {
  columns: ['id', 'name', 'salary', 'department_id', 'age', 'city'],
  rows: [
    [1, 'Ravi', 62000, 1, 30, 'Delhi'],
    [2, 'Priya', 48000, 1, 26, 'Mumbai'],
    [3, 'Amit', 55000, 2, null, 'Delhi'],
    [4, 'Sara', 75000, 2, 34, 'Pune'],
    [5, 'John', 40000, null, 24, 'Delhi'],
    [6, 'Nina', 40000, 3, 29, 'Pune'],
    [7, 'Omar', 62000, 3, 41, null],
    [8, 'Lena', 52000, 3, 27, 'Delhi'],
  ],
}

const departments: TableData = {
  columns: ['id', 'department_name'],
  rows: [
    [1, 'Engineering'],
    [2, 'Sales'],
    [3, 'Marketing'],
  ],
}

const TABLES: Record<string, TableData> = { employees, departments }
const getTableData = (name: string): TableData | null => TABLES[name] ?? null

function interpret(sql: string) {
  return interpretQuery(sql, [sql])
}

function run(sql: string) {
  const interpretation = interpret(sql)
  expect(interpretation.unsupportedReasons).toEqual([])
  expect(interpretation.structure).not.toBeNull()
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

function runWith(sql: string, options: SimulationOptions) {
  const interpretation = interpret(sql)
  expect(interpretation.unsupportedReasons).toEqual([])
  expect(interpretation.structure).not.toBeNull()
  const outcome = simulateQuery(sql, interpretation.structure!, getTableData, options)
  if (!outcome.ok) throw new Error(outcome.reasons.join('; '))
  return outcome.trace
}

const SINGLE_CTE = `WITH department_totals AS (
  SELECT department_id, COUNT(*) AS employee_count
  FROM employees
  WHERE department_id IS NOT NULL
  GROUP BY department_id
)
SELECT * FROM department_totals ORDER BY department_id`

const CHAINED = `WITH high AS (
  SELECT id, name, salary FROM employees WHERE salary > 55000
), named AS (
  SELECT id, name FROM high WHERE id < 5
)
SELECT * FROM named ORDER BY id`

describe('CTE interpretation', () => {
  it('creates one CTE child block per definition', () => {
    const interpretation = interpret(SINGLE_CTE)
    expect(interpretation.unsupportedReasons).toEqual([])
    const structure = interpretation.structure
    expect(structure).not.toBeNull()
    expect(structure?.ctes).toHaveLength(1)
    const cte = structure!.ctes[0]!
    expect(cte.name).toBe('department_totals')
    expect(cte.columns).toBeNull()
    expect(cte.query.blockKind).toBe('cte')
    expect(cte.query.parentId).toBe(structure!.id)
    expect(cte.query.depth).toBe(1)
    expect(cte.query.consumingStage).toBeNull()
  })

  it('assigns deterministic ids in interpretation order', () => {
    const first = interpret(CHAINED)
    const second = interpret(CHAINED)
    expect(first.structure?.id).toBe('q1')
    expect(first.structure?.ctes.map((cte) => cte.query.id)).toEqual(['q2', 'q3'])
    expect(second.structure?.ctes.map((cte) => cte.query.id)).toEqual(['q2', 'q3'])
  })

  it('allocates ids in interpretation order across CTEs and scalar subqueries', () => {
    const structure = interpret(
      `WITH first AS (SELECT id, (SELECT MAX(salary) FROM employees) AS m FROM employees),
            second AS (SELECT id FROM first)
       SELECT name FROM employees WHERE id = (SELECT MIN(id) FROM employees)`,
    ).structure
    expect(structure?.id).toBe('q1')
    const [first, second] = structure!.ctes
    expect(first?.query.id).toBe('q2')
    expect(first?.query.subqueries[0]?.query.id).toBe('q3')
    expect(second?.query.id).toBe('q4')
    expect(structure?.subqueries[0]?.query.id).toBe('q5')
  })

  it('records dependencies on earlier CTEs by name', () => {
    const structure = interpret(CHAINED).structure
    const [high, named] = structure!.ctes
    expect(high?.dependencies).toEqual([])
    expect(named?.dependencies).toEqual(['high'])
  })

  it('maps an explicit column list', () => {
    const structure = interpret(
      'WITH summary(employee_id, employee_name) AS (SELECT id, name FROM employees) SELECT * FROM summary',
    ).structure
    expect(structure?.ctes[0]?.columns).toEqual(['employee_id', 'employee_name'])
  })

  it('interprets a scalar subquery inside a CTE as its child block', () => {
    const structure = interpret(
      `WITH enriched AS (
        SELECT id, (SELECT MAX(salary) FROM employees) AS top_salary FROM employees
      ) SELECT * FROM enriched`,
    ).structure
    const cte = structure!.ctes[0]!
    expect(cte.query.subqueries).toHaveLength(1)
    const subquery = cte.query.subqueries[0]!
    expect(subquery.query.blockKind).toBe('scalar')
    expect(subquery.query.parentId).toBe(cte.query.id)
    expect(subquery.query.depth).toBe(2)
  })

  it('rejects WITH RECURSIVE with a precise reason', () => {
    const interpretation = interpret(
      'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r',
    )
    expect(interpretation.structure).toBeNull()
    expect(interpretation.unsupportedReasons.join(' ')).toMatch(/recursive/i)
  })

  it('rejects nested WITH clauses inside a CTE body', () => {
    const interpretation = interpret(
      'WITH a AS (WITH b AS (SELECT 1 AS n) SELECT * FROM b) SELECT * FROM a',
    )
    expect(interpretation.structure).toBeNull()
    expect(interpretation.unsupportedReasons.join(' ')).toMatch(/nested WITH/i)
  })

  it('rejects duplicate CTE names in one WITH clause', () => {
    const interpretation = interpret(
      'WITH a AS (SELECT id FROM employees), a AS (SELECT id FROM employees) SELECT * FROM a',
    )
    expect(interpretation.structure).toBeNull()
    expect(interpretation.unsupportedReasons.join(' ')).toMatch(/more than once/i)
  })
})

describe('CTE simulation', () => {
  it('feeds real CTE rows to the outer query', () => {
    const trace = run(SINGLE_CTE)
    expect(trace.finalColumns).toEqual(['department_id', 'employee_count'])
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 2],
      [2, 2],
      [3, 3],
    ])
    const cte = trace.nestedQueries?.find((block) => block.kind === 'cte')
    expect(cte).toBeDefined()
    expect(cte?.cteName).toBe('department_totals')
    expect(cte?.finalColumns).toEqual(['department_id', 'employee_count'])
    expect(cte?.status).toBe('complete')
  })

  it('simulates chained CTEs and records the dependency edge', () => {
    const trace = run(CHAINED)
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 'Ravi'],
      [4, 'Sara'],
    ])
    const blocks = trace.nestedQueries ?? []
    expect(blocks.map((block) => block.cteName)).toEqual(['high', 'named'])
    const named = blocks.find((block) => block.cteName === 'named')!
    const high = blocks.find((block) => block.cteName === 'high')!
    expect(named.dependencies).toEqual([{ blockId: high.id, stage: 'FROM' }])
  })

  it('applies an explicit column list to the consuming relation', () => {
    const trace = run(
      `WITH summary(employee_id, employee_name) AS (
        SELECT id, name FROM employees WHERE id <= 2
      ) SELECT * FROM summary ORDER BY employee_id`,
    )
    expect(trace.finalColumns).toEqual(['employee_id', 'employee_name'])
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 'Ravi'],
      [2, 'Priya'],
    ])
    const cte = (trace.nestedQueries ?? []).find((block) => block.kind === 'cte')
    expect(cte).toBeDefined()
    if (cte === undefined) return
    expect(cte.cteColumns).toEqual(['employee_id', 'employee_name'])
    // The CTE's own body snapshots keep the body's source labels.
    expect(cte.stageSnapshots.at(-1)?.columns).toEqual(['id', 'name'])
  })

  it('lets a CTE shadow a physical table of the same name', () => {
    const trace = run(
      'WITH departments AS (SELECT id, name AS department_name FROM employees WHERE id = 1) SELECT * FROM departments',
    )
    // The physical `departments` table has three rows; the CTE shadows it.
    expect(trace.finalRows.map((row) => row.values)).toEqual([[1, 'Ravi']])
    expect(trace.sourceTables?.[0]?.role).toBe('cte')
  })

  it('uses the physical table when a later CTE of the same name is not visible yet', () => {
    const trace = run(
      `WITH a AS (SELECT * FROM departments),
            departments AS (SELECT id FROM employees WHERE id = 1)
       SELECT * FROM a ORDER BY id`,
    )
    // `a` was interpreted against the physical departments table; the
    // later CTE only shadows the name for the outer query.
    expect(trace.finalColumns).toEqual(['id', 'department_name'])
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 'Engineering'],
      [2, 'Sales'],
      [3, 'Marketing'],
    ])
  })

  it('rejects a forward reference to a later CTE', () => {
    const sql =
      'WITH a AS (SELECT * FROM b), b AS (SELECT id FROM employees WHERE id = 1) SELECT * FROM a'
    const interpretation = interpret(sql)
    expect(interpretation.structure).not.toBeNull()
    const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reasons.join(' ')).toMatch(/referenced before it is defined|forward reference/i)
  })

  it('rejects a self-reference instead of treating it as a physical table', () => {
    const sql = 'WITH a AS (SELECT * FROM a) SELECT * FROM a'
    const interpretation = interpret(sql)
    const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reasons.join(' ')).toMatch(/refers to itself|recursive/i)
  })

  it('evaluates multiple sibling CTEs independently', () => {
    const trace = run(
      `WITH low AS (SELECT id, name FROM employees WHERE id <= 3),
            high AS (SELECT id, name FROM employees WHERE id > 5)
       SELECT * FROM low ORDER BY id`,
    )
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 'Ravi'],
      [2, 'Priya'],
      [3, 'Amit'],
    ])
    const blocks = trace.nestedQueries ?? []
    expect(blocks.map((block) => block.cteName)).toEqual(['low', 'high'])
    expect(blocks.every((block) => block.dependencies?.length === 0)).toBe(true)
  })

  it('reads a CTE through a JOIN', () => {
    const trace = run(
      `WITH dept AS (SELECT id, department_name FROM departments)
       SELECT e.name, d.department_name
       FROM employees e JOIN dept d ON d.id = e.department_id
       WHERE e.id <= 3
       ORDER BY e.name`,
    )
    expect(trace.finalColumns).toEqual(['name', 'department_name'])
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      ['Amit', 'Sales'],
      ['Priya', 'Engineering'],
      ['Ravi', 'Engineering'],
    ])
    const cteSource = trace.sourceTables?.find((table) => table.role === 'cte')
    expect(cteSource).toMatchObject({ consumerStage: 'JOIN' })
  })

  it('rejects an explicit column list with the wrong arity', () => {
    const sql = 'WITH c(x) AS (SELECT id, name FROM employees) SELECT * FROM c'
    const interpretation = interpret(sql)
    expect(interpretation.structure).not.toBeNull()
    const outcome = simulateQuery(sql, interpretation.structure!, getTableData)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reasons.join(' ')).toMatch(/declares 1 column/i)
  })

  it('simulates a scalar subquery inside a CTE', () => {
    const trace = run(
      `WITH enriched AS (
        SELECT id, salary, (SELECT MAX(salary) FROM employees) AS top_salary
        FROM employees WHERE id <= 2
      ) SELECT * FROM enriched ORDER BY id`,
    )
    expect(trace.finalColumns).toEqual(['id', 'salary', 'top_salary'])
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      [1, 62000, 75000],
      [2, 48000, 75000],
    ])
    const blocks = trace.nestedQueries ?? []
    const cte = blocks.find((block) => block.kind === 'cte')!
    const scalar = blocks.find((block) => block.kind === 'scalar')!
    expect(scalar.parentId).toBe(cte.id)
    expect(scalar.depth).toBe(2)
  })

  it('makes a CTE readable from a scalar subquery in the outer query', () => {
    const trace = run(
      `WITH avg_sal AS (SELECT AVG(salary) AS avg_salary FROM employees)
       SELECT name FROM employees
       WHERE salary > (SELECT avg_salary FROM avg_sal)
       ORDER BY name`,
    )
    expect(trace.finalRows.map((row) => row.values)).toEqual([
      ['Amit'],
      ['Omar'],
      ['Ravi'],
      ['Sara'],
    ])
    const blocks = trace.nestedQueries ?? []
    expect(blocks.map((block) => block.kind)).toEqual(['cte', 'scalar'])
    expect(blocks[1]?.parentId).toBe(ROOT_BLOCK_ID)
  })

  it('keeps CTE snapshots and events isolated by block id', () => {
    const trace = run(CHAINED)
    for (const block of trace.nestedQueries ?? []) {
      expect(block.stageSnapshots.every((snapshot) => snapshot.blockId === block.id)).toBe(true)
      expect((block.events ?? []).every((event) => event.blockId === block.id)).toBe(true)
    }
  })

  it('is deterministic across repeated runs', () => {
    const first = run(CHAINED)
    const second = run(CHAINED)
    expect(first.nestedQueries).toEqual(second.nestedQueries)
    expect(first.finalRows).toEqual(second.finalRows)
  })
})

describe('CTE correctness — truncation and nested dependencies', () => {
  it('propagates a display cap through real CTE dependencies', () => {
    const trace = runWith(
      `WITH base AS (
         SELECT id, name, salary FROM employees
       ), capped AS (
         SELECT id, name FROM base WHERE salary > 50000
       )
       SELECT * FROM capped ORDER BY id`,
      { maxRows: 3 },
    )
    const base = trace.nestedQueries!.find((block) => block.cteName === 'base')!
    const capped = trace.nestedQueries!.find((block) => block.cteName === 'capped')!

    // The base CTE hit its own display cap.
    expect(base.truncated).toBe(true)
    expect(base.incomplete).toBe(true)
    // The dependent CTE was not itself capped; it inherited incompleteness
    // through its real dependency edge, not by name.
    expect(capped.truncated).toBe(false)
    expect(capped.incomplete).toBe(true)
    expect(capped.incompleteReasons?.join(' ')).toMatch(/base/i)
    expect(capped.dependencies).toEqual([{ blockId: base.id, stage: 'FROM' }])

    // The outer query consumed the incomplete CTE, so the trace is incomplete.
    expect(trace.incomplete).toBe(true)
    expect(trace.incompleteReasons?.join(' ')).toMatch(/capped/i)
  })

  it('records a CTE dependency reached through a nested scalar subquery', () => {
    const trace = run(
      `WITH base AS (
         SELECT id, salary FROM employees
       ), enriched AS (
         SELECT id, (SELECT MAX(salary) FROM base) AS top_salary
         FROM employees WHERE id <= 2
       )
       SELECT * FROM enriched ORDER BY id`,
    )
    const base = trace.nestedQueries!.find((block) => block.cteName === 'base')!
    const enriched = trace.nestedQueries!.find((block) => block.cteName === 'enriched')!
    const scalar = trace.nestedQueries!.find(
      (block) => block.kind === 'scalar' && block.parentId === enriched.id,
    )
    expect(scalar).toBeDefined()

    const dependency = (enriched.dependencies ?? []).find(
      (entry) => entry.blockId === base.id,
    )
    expect(dependency).toBeDefined()
    // The dependency is attributed to the scalar block that performed the read.
    expect(dependency?.viaBlockId).toBe(scalar?.id)
    expect(dependency?.referenceStage).toBe('FROM')

    const graph = buildFlowGraph(trace)
    const from = `${base.id}-data-SELECT`
    const to = `${enriched.id}-op-SELECT`
    expect(
      graph.edges.some((edge) => edge.kind === 'cte' && edge.from === from && edge.to === to),
    ).toBe(true)

    // Upstream tracing from the dependent CTE follows the dependency edge
    // into the base CTE's own subgraph.
    const traced = traceUpstreamPath(graph, to)
    expect(traced.hasSelection).toBe(true)
    expect(traced.nodeIds.has(from)).toBe(true)
    expect(traced.edgeIds.size).toBeGreaterThan(0)
  })
})

describe('CTE blocks — selector and graph', () => {
  it('lists CTEs as their own playable blocks', () => {
    const trace = run(CHAINED)
    const blocks = blocksOf(trace)
    expect(blocks.map((block) => block.id)).toEqual([ROOT_BLOCK_ID, 'q2', 'q3'])
    expect(blocks[1]).toMatchObject({ kind: 'cte', depth: 1, parentId: ROOT_BLOCK_ID, playable: true })
    expect(blocks[2]).toMatchObject({ kind: 'cte', depth: 1, parentId: ROOT_BLOCK_ID, playable: true })
  })

  it('gives every block unique namespaced graph nodes', () => {
    const trace = run(CHAINED)
    const graph = buildFlowGraph(trace)
    const ids = graph.nodes.map((node) => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const block of trace.nestedQueries ?? []) {
      for (const snapshot of block.stageSnapshots) {
        expect(ids).toContain(`${block.id}-data-${snapshot.stage}`)
      }
    }
    expect(ids).toContain('op-SELECT')
    expect(ids).toContain('data-SELECT')
  })

  it('wires a CTE result into the stage that consumes it', () => {
    const trace = run(SINGLE_CTE)
    const graph = buildFlowGraph(trace)
    const cte = trace.nestedQueries!.find((block) => block.kind === 'cte')!
    const source = graph.nodes.find((node) => node.table?.role === 'cte')
    expect(source).toBeDefined()
    expect(source?.table?.queryId).toBe(cte.id)
    const last = cte.stageSnapshots.at(-1)!
    const edge = graph.edges.find(
      (candidate) => candidate.kind === 'cte' && candidate.to === source?.id,
    )
    expect(edge).toBeDefined()
    expect(edge?.from).toBe(`${cte.id}-data-${last.stage}`)
  })

  it('identifies CTE source and operation nodes in the inspector', () => {
    const trace = run(SINGLE_CTE)
    const graph = buildFlowGraph(trace)
    const cte = (trace.nestedQueries ?? []).find((block) => block.kind === 'cte')
    expect(cte).toBeDefined()
    if (cte === undefined) return

    const source = graph.nodes.find((node) => node.table?.role === 'cte')
    expect(source).toBeDefined()
    if (source !== undefined) {
      const inspection = inspectNode(source, trace)
      expect(inspection.header.title).toContain('CTE result')
      expect(inspection.header.operation).toBe('CTE')
      expect(inspection.header.badge).toBe('CTE')
      expect(inspection.output?.rows).toHaveLength(3)
    }

    const operation = graph.nodes.find(
      (node) => node.blockId === cte.id && node.kind === 'operation',
    )
    expect(operation).toBeDefined()
    if (operation !== undefined) {
      expect(inspectNode(operation, trace).header.blockLabel).toContain('CTE')
    }
  })

  it('wires a CTE that feeds a JOIN to the join operation', () => {
    const trace = run(
      `WITH dept AS (SELECT id, department_name FROM departments)
       SELECT e.name FROM employees e JOIN dept d ON d.id = e.department_id`,
    )
    const graph = buildFlowGraph(trace)
    const cte = trace.nestedQueries!.find((block) => block.kind === 'cte')!
    const source = graph.nodes.find((node) => node.table?.role === 'cte')!
    expect(source).toBeDefined()
    const intoSource = graph.edges.find(
      (edge) => edge.kind === 'cte' && edge.to === source.id,
    )
    expect(intoSource?.from).toBe(`${cte.id}-data-SELECT`)
    expect(
      graph.edges.some(
        (edge) => edge.kind === 'cte' && edge.from === source.id && edge.to === 'op-JOIN',
      ),
    ).toBe(true)
  })

  it('wires a CTE-to-CTE dependency to the exact consuming stage', () => {
    const trace = run(CHAINED)
    const graph = buildFlowGraph(trace)
    const high = trace.nestedQueries!.find((block) => block.cteName === 'high')!
    const named = trace.nestedQueries!.find((block) => block.cteName === 'named')!
    const dependency = graph.edges.find(
      (edge) =>
        edge.kind === 'cte' &&
        edge.label === 'cte' &&
        edge.from === `${high.id}-data-SELECT` &&
        edge.to === `${named.id}-data-FROM`,
    )
    expect(dependency).toBeDefined()
  })

  it('activates only the selected CTE block during playback', () => {
    const trace = run(CHAINED)
    const graph = buildFlowGraph(trace)
    const state = deriveFlowState(graph, new Set(['q2:FROM']), null, false)
    expect(state.nodes['q2-data-FROM']).toBe('completed')
    expect(state.nodes['op-WHERE']).not.toBe('completed')
    expect(state.nodes['q3-data-FROM']).not.toBe('completed')

    const events = blockEvents(trace, 'q2')
    expect(events.length).toBeGreaterThan(0)
    const view = foldEvents(events, events.length - 1, ROOT_BLOCK_ID, 'q2')
    expect(view.completedStageKeys.every((key) => key.startsWith('q2:'))).toBe(true)
  })

  it('does not leak CTE stage keys into the root timeline', () => {
    const trace = run(CHAINED)
    const rootView = foldEvents(trace.events, trace.events.length - 1, ROOT_BLOCK_ID)
    expect(rootView.completedStageKeys.some((key) => key.startsWith('q2:'))).toBe(false)
    expect(rootView.completedStageKeys.some((key) => key.startsWith('q3:'))).toBe(false)
  })
})

describe('CTE capability detection', () => {
  it('reports CTEs as a detected construct', () => {
    const capability = analyzeCapability(interpret(CHAINED))
    expect(capability.supported).toBe(true)
    expect(capability.detected.some((entry) => entry.kind === 'cte')).toBe(true)
  })
})
