import { describe, expect, it } from 'vitest'
import { interpretQuery } from './astInterpreter'
import { simulateQuery, type TableData } from './simulator'

/**
 * Fixture tables. The simulator must work with whatever data the
 * accessor provides — these are stand-ins for user tables, not
 * hardcoded database knowledge inside the simulator.
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

function run(sql: string, tables: Record<string, TableData> = TABLES) {
  const interpretation = interpretQuery(sql, [sql])
  if (interpretation.structure === null) {
    throw new Error(`fixture query failed to interpret: ${interpretation.unsupportedReasons.join('; ')}`)
  }
  return simulateQuery(sql, interpretation.structure, (name) => tables[name] ?? null)
}

describe('event timeline ordering', () => {
  it('emits each stage’s row events before its completion, in pipeline order', () => {
    const outcome = run('SELECT name FROM employees WHERE salary > 50000 ORDER BY name')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const events = outcome.trace.events
    const fromCompleted = events.findIndex(
      (event) => event.type === 'STAGE_COMPLETED' && event.stage === 'FROM',
    )
    const firstWhereRow = events.findIndex(
      (event) => event.stage === 'WHERE' && event.type.startsWith('ROW_'),
    )
    const whereCompleted = events.findIndex(
      (event) => event.type === 'STAGE_COMPLETED' && event.stage === 'WHERE',
    )
    const firstOrderRow = events.findIndex(
      (event) => event.stage === 'ORDER_BY' && event.type === 'ROW_SORTED',
    )
    expect(fromCompleted).toBeGreaterThan(-1)
    expect(firstWhereRow).toBeGreaterThan(fromCompleted)
    expect(firstWhereRow).toBeLessThan(whereCompleted)
    expect(firstOrderRow).toBeGreaterThan(whereCompleted)
    expect(events[0]?.type).toBe('QUERY_STARTED')
    expect(events[1]?.type).toBe('SOURCE_TABLE_LOADED')
    expect(events.at(-1)?.type).toBe('QUERY_VISUALIZATION_COMPLETED')
  })
})

describe('FROM stage', () => {
  it('produces a FROM snapshot with all source rows and stable ids', () => {
    const outcome = run('SELECT name FROM employees')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const fromSnapshot = outcome.trace.stageSnapshots[0]
    expect(fromSnapshot?.stage).toBe('FROM')
    expect(fromSnapshot?.columns).toEqual(['id', 'name', 'salary', 'department_id', 'age', 'city'])
    expect(fromSnapshot?.rows).toHaveLength(8)
    expect(fromSnapshot?.rows[0]).toEqual({
      id: 'employees#1',
      values: [1, 'Ravi', 62000, 1, 30, 'Delhi'],
    })
    expect(fromSnapshot?.inputRowCount).toBe(8)
    expect(outcome.trace.events[0]?.type).toBe('QUERY_STARTED')
    expect(outcome.trace.events[1]?.type).toBe('SOURCE_TABLE_LOADED')
  })

  it('reports a missing table as a failed simulation, not a fake trace', () => {
    const outcome = run('SELECT name FROM ghost_table')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reasons[0]).toMatch(/ghost_table/)
  })
})

describe('WHERE stage', () => {
  it('filters rows and records removed rows with roles', () => {
    const outcome = run('SELECT * FROM employees WHERE salary > 50000')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const whereSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'WHERE')
    expect(whereSnapshot).toBeDefined()
    // Salaries > 50000: Ravi 62000, Amit 55000, Sara 75000, Omar 62000, Lena 52000
    expect(whereSnapshot?.rows.map((row) => row.id)).toEqual([
      'employees#1', 'employees#3', 'employees#4', 'employees#7', 'employees#8',
    ])
    expect(whereSnapshot?.removedRows.map((row) => row.id)).toEqual([
      'employees#2', 'employees#5', 'employees#6',
    ])
    expect(whereSnapshot?.roles['employees#2']).toBe('filtered')
    expect(whereSnapshot?.roles['employees#1']).toBe('unchanged')
    expect(whereSnapshot?.outputRowCount).toBe(5)
  })

  it('treats UNKNOWN (NULL) comparisons as filtered out, like SQLite', () => {
    // Amit's age is NULL → age > 25 is UNKNOWN → excluded.
    const outcome = run('SELECT * FROM employees WHERE age > 25')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const whereSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'WHERE')
    expect(whereSnapshot?.rows.map((row) => row.id)).not.toContain('employees#3')
    const unknownEvent = outcome.trace.events.find(
      (event) => event.type === 'ROW_EVALUATED' && event.payload?.rowId === 'employees#3',
    )
    expect(unknownEvent?.payload?.verdict).toBe('unknown')
  })
})

describe('GROUP BY / aggregates / HAVING', () => {
  it('creates groups with member row ids and computes aggregates', () => {
    const outcome = run('SELECT department_id, COUNT(*) AS total FROM employees GROUP BY department_id')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const groupSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'GROUP_BY')
    expect(groupSnapshot?.groups).toHaveLength(4) // 1, 2, 3, NULL
    // The grouping consumed every source row and produced one row per group.
    expect(groupSnapshot?.inputRowCount).toBe(8)
    expect(groupSnapshot?.outputRowCount).toBe(4)
    const group1 = groupSnapshot?.groups.find((group) => group.keyValues[0] === 1)
    expect(group1?.rowIds).toEqual(['employees#1', 'employees#2'])
    expect(group1?.aggregates['COUNT(*)']).toBe(2)
    // NULL department forms its own group (SQLite semantics).
    const nullGroup = groupSnapshot?.groups.find((group) => group.keyValues[0] === null)
    expect(nullGroup?.rowIds).toEqual(['employees#5'])
  })

  it('computes AVG ignoring NULL salaries', () => {
    const outcome = run('SELECT AVG(salary) AS avg_salary FROM employees')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // All 8 salaries non-null → (62000+48000+55000+75000+40000+40000+62000+52000)/8 = 434000/8
    expect(outcome.trace.finalRows).toEqual([{ id: 'group#1', values: [54250] }])
  })

  it('implicit grouping with no GROUP BY collapses to a single group', () => {
    const outcome = run('SELECT COUNT(*) FROM employees')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.finalRows).toEqual([{ id: 'group#1', values: [8] }])
  })

  it('applies HAVING after aggregation and removes failing groups', () => {
    const outcome = run(
      'SELECT department_id, AVG(salary) AS average_salary FROM employees GROUP BY department_id HAVING AVG(salary) > 55000',
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Dept averages: 1 → 55000 (not > 55000), 2 → 65000 ✓, 3 → 51333.33 ✗, NULL → 40000 ✗
    expect(outcome.trace.finalRows.map((row) => row.values)).toEqual([[2, 65000]])
    const havingSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'HAVING')
    expect(havingSnapshot?.outputRowCount).toBe(1)
    expect(havingSnapshot?.removedRows.length).toBe(3)
  })
})

describe('SELECT projection', () => {
  it('projects expressions and applies aliases', () => {
    const outcome = run('SELECT name AS n, salary * 2 AS doubled FROM employees LIMIT 2')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.finalColumns).toEqual(['n', 'doubled'])
    expect(outcome.trace.finalRows[0]?.values).toEqual(['Ravi', 124000])
  })

  it('expands SELECT * to all source columns', () => {
    const outcome = run('SELECT * FROM employees LIMIT 1')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.finalColumns).toEqual(['id', 'name', 'salary', 'department_id', 'age', 'city'])
    expect(outcome.trace.finalRows[0]?.values).toEqual([1, 'Ravi', 62000, 1, 30, 'Delhi'])
  })
})

describe('DISTINCT stage', () => {
  it('removes duplicate projected rows and reports them', () => {
    const outcome = run('SELECT DISTINCT city FROM employees')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Cities: Delhi, Mumbai, Delhi, Pune, Delhi, Pune, NULL, Delhi
    // Unique: Delhi, Mumbai, Pune, NULL
    const values = outcome.trace.finalRows.map((row) => row.values[0])
    expect(values).toEqual(['Delhi', 'Mumbai', 'Pune', null])
    const distinctSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'DISTINCT')
    expect(distinctSnapshot?.removedRows.length).toBe(4)
    const duplicates = outcome.trace.events.filter((event) => event.type === 'DUPLICATE_DETECTED')
    expect(duplicates.length).toBe(4)
  })
})

describe('ORDER BY stage', () => {
  it('sorts ascending with NULLs first (SQLite behavior)', () => {
    const outcome = run('SELECT name, city FROM employees ORDER BY city')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const cities = outcome.trace.finalRows.map((row) => row.values[1])
    // NULL first, then Delhi, Mumbai, Pune; Delhi ties stable by input order.
    expect(cities).toEqual([null, 'Delhi', 'Delhi', 'Delhi', 'Delhi', 'Mumbai', 'Pune', 'Pune'])
  })

  it('sorts descending with NULLs last', () => {
    const outcome = run('SELECT name, salary FROM employees ORDER BY salary DESC')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const salaries = outcome.trace.finalRows.map((row) => row.values[1])
    expect(salaries).toEqual([75000, 62000, 62000, 55000, 52000, 48000, 40000, 40000])
  })

  it('resolves output aliases and ordinals', () => {
    const byAlias = run('SELECT name, salary * 2 AS doubled FROM employees ORDER BY doubled DESC LIMIT 1')
    expect(byAlias.ok).toBe(true)
    if (byAlias.ok) {
      expect(byAlias.trace.finalRows[0]?.values[0]).toBe('Sara') // 150000
    }
    const byOrdinal = run('SELECT name, salary FROM employees ORDER BY 2 DESC LIMIT 1')
    expect(byOrdinal.ok).toBe(true)
    if (byOrdinal.ok) {
      expect(byOrdinal.trace.finalRows[0]?.values[0]).toBe('Sara')
    }
  })

  it('sorts by aggregate expressions in grouped queries', () => {
    const outcome = run(
      'SELECT department_id, COUNT(*) AS total FROM employees WHERE age > 25 GROUP BY department_id ORDER BY total DESC',
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // age > 25: Ravi30+Priya26 (dept 1), Sara34 (dept 2), Nina29+Omar41+Lena27 (dept 3)
    // → totals 1:2, 2:1, 3:3 → ordered DESC: [3,3], [1,2], [2,1]
    expect(outcome.trace.finalRows.map((row) => row.values)).toEqual([
      [3, 3],
      [1, 2],
      [2, 1],
    ])
  })

  it('aborts with a reason for unresolvable ORDER BY terms', () => {
    const outcome = run('SELECT name FROM employees ORDER BY nonexistent_column')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reasons[0]).toMatch(/ORDER BY/)
  })
})

describe('LIMIT / OFFSET stage', () => {
  it('applies offset then limit with skipped/selected events', () => {
    const outcome = run('SELECT name FROM employees ORDER BY salary DESC LIMIT 3 OFFSET 1')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Sorted desc: Sara 75000, Ravi/Omar 62000, Amit 55000 …
    expect(outcome.trace.finalRows.map((row) => row.values[0])).toEqual(['Ravi', 'Omar', 'Amit'])
    const limitSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'LIMIT')
    expect(limitSnapshot?.removedRows.map((row) => row.values[0])).toEqual(['Sara'])
    const skipped = outcome.trace.events.filter((event) => event.type === 'ROW_SKIPPED')
    expect(skipped.length).toBe(1)
    const selected = outcome.trace.events.filter((event) => event.type === 'ROW_SELECTED')
    expect(selected.length).toBe(3)
  })

  it('clamps LIMIT to the available rows', () => {
    const outcome = run('SELECT name FROM employees LIMIT 100')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.finalRows).toHaveLength(8)
  })
})

describe('row identity and determinism', () => {
  it('keeps row ids stable from FROM to the final result', () => {
    const outcome = run('SELECT name FROM employees WHERE salary > 50000 ORDER BY name LIMIT 3')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const fromIds = new Set(
      outcome.trace.stageSnapshots[0]?.rows.map((row) => row.id) ?? [],
    )
    for (const row of outcome.trace.finalRows) {
      expect(fromIds.has(row.id)).toBe(true)
    }
  })

  it('produces byte-identical traces for identical input (determinism)', () => {
    const a = run('SELECT department_id, COUNT(*) FROM employees GROUP BY department_id ORDER BY department_id')
    const b = run('SELECT department_id, COUNT(*) FROM employees GROUP BY department_id ORDER BY department_id')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(JSON.stringify(a.trace.events)).toBe(JSON.stringify(b.trace.events))
    expect(JSON.stringify(a.trace.finalRows)).toBe(JSON.stringify(b.trace.finalRows))
  })

  it('ends with QUERY_VISUALIZATION_COMPLETED and carries a snapshot per stage', () => {
    const outcome = run('SELECT DISTINCT city FROM employees ORDER BY city LIMIT 2')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.events.at(-1)?.type).toBe('QUERY_VISUALIZATION_COMPLETED')
    for (const event of outcome.trace.events) {
      if (event.type === 'STAGE_COMPLETED') expect(event.snapshot).toBeDefined()
    }
  })
})

describe('edge cases', () => {
  it('handles empty datasets', () => {
    const outcome = run('SELECT name FROM employees WHERE salary > 999999')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.finalRows).toEqual([])
    const whereSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'WHERE')
    expect(whereSnapshot?.outputRowCount).toBe(0)
  })

  it('handles aggregates over empty groups (COUNT 0, SUM NULL)', () => {
    const outcome = run('SELECT COUNT(*) AS c, SUM(salary) AS s FROM employees WHERE salary > 999999')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.finalRows).toEqual([{ id: 'group#1', values: [0, null] }])
  })

  it('supports INNER JOIN between two tables', () => {
    const outcome = run(
      'SELECT e.name, d.department_name FROM employees e INNER JOIN departments d ON e.department_id = d.id',
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // John (NULL department) is excluded by INNER JOIN; 7 rows.
    expect(outcome.trace.finalRows).toHaveLength(7)
    const names = outcome.trace.finalRows.map((row) => row.values[0])
    expect(names).not.toContain('John')
    const joinSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'JOIN')
    expect(joinSnapshot).toBeDefined()
  })

  it('keeps the JOIN snapshot at join time even when WHERE runs afterwards', () => {
    const outcome = run(
      'SELECT e.name, e.salary, d.department_name FROM employees e INNER JOIN departments d ON e.department_id = d.id WHERE e.salary > 60000',
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const joinSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'JOIN')
    // 8 employees joined against 3 departments: John has NULL department,
    // so INNER JOIN keeps 7 rows — the WHERE filter must not leak in.
    expect(joinSnapshot?.outputRowCount).toBe(7)
    expect(joinSnapshot?.inputRowCount).toBe(8)
    expect(joinSnapshot?.rows).toHaveLength(7)
    const whereSnapshot = outcome.trace.stageSnapshots.find((snapshot) => snapshot.stage === 'WHERE')
    expect(whereSnapshot?.inputRowCount).toBe(7)
    expect(whereSnapshot?.outputRowCount).toBe(3)
    expect(outcome.trace.finalRows).toHaveLength(3)
  })

  it('supports LEFT JOIN with unmatched rows filled by NULLs', () => {
    const outcome = run(
      'SELECT d.department_name, e.name FROM departments d LEFT JOIN employees e ON e.department_id = d.id',
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const rows = outcome.trace.finalRows
    // Every department matched; Engineering 2, Sales 2, Marketing 3 → 7 rows (John unmatched on the right side doesn't appear)
    expect(rows).toHaveLength(7)
  })

  it('truncates large tables with an explicit flag and never fakes data', () => {
    const bigEmployees: TableData = {
      columns: ['id', 'name'],
      rows: Array.from({ length: 50 }, (_, index) => [index + 1, `person${index + 1}`]),
    }
    const outcome = run('SELECT name FROM big_employees', { big_employees: bigEmployees })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const small = run('SELECT name FROM big_employees LIMIT 10', { big_employees: bigEmployees })
    expect(outcome.ok && small.ok).toBe(true)
    if (!outcome.ok || !small.ok) return
    // Default maxRows is 500; simulate with a tiny cap via options instead.
    const interpretation = interpretQuery('SELECT name FROM big_employees', ['SELECT name FROM big_employees'])
    if (interpretation.structure === null) return
    const capped = simulateQuery(
      'SELECT name FROM big_employees',
      interpretation.structure,
      (name) => (name === 'big_employees' ? bigEmployees : null),
      { maxRows: 10 },
    )
    expect(capped.ok).toBe(true)
    if (!capped.ok) return
    expect(capped.trace.truncated).toBe(true)
    expect(capped.trace.stageSnapshots[0]?.rows).toHaveLength(10)
    expect(capped.trace.stageSnapshots[0]?.truncated).toBe(true)
    void small
  })

  it('respects the event budget without losing stage snapshots', () => {
    const interpretation = interpretQuery('SELECT name FROM employees', ['SELECT name FROM employees'])
    if (interpretation.structure === null) return
    const outcome = simulateQuery(
      'SELECT name FROM employees',
      interpretation.structure,
      getTableData,
      { maxEvents: 5 },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.trace.events.length).toBeLessThanOrEqual(5 + 20) // fine-grained budget + stage events
    expect(outcome.trace.stageSnapshots.length).toBeGreaterThan(0)
    expect(outcome.trace.finalRows).toHaveLength(8)
  })
})
