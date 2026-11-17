import { describe, expect, it } from 'vitest'
import { mapQueryClauses, spanOfStage } from './clauseMapper'
import type { NestedQueryTrace } from '../../types/visualization'

/**
 * Occurrence- and block-aware clause mapping. The outer and inner query
 * share clause keywords; each occurrence must resolve to its own real
 * source range in the correct block.
 */

function block(id: string, sql: string): NestedQueryTrace {
  return {
    id,
    kind: 'scalar',
    label: `Scalar subquery · ${id}`,
    sql,
    stageSnapshots: [],
    finalColumns: [],
    finalRows: [],
    parentStage: 'WHERE',
    parentId: 'q1',
    depth: 1,
    correlated: false,
    status: 'complete',
  }
}

const SQL =
  'SELECT name FROM employees WHERE salary > (SELECT AVG(budget) FROM departments WHERE budget > 50000)'

const INNER_SQL = 'SELECT AVG(budget) FROM departments WHERE budget > 50000'

describe('mapQueryClauses — nested blocks', () => {
  const spans = mapQueryClauses(SQL, {
    nestedQueries: [block('q2', INNER_SQL)],
    rootBlockId: 'q1',
  })

  it('attributes outer clauses to the root block', () => {
    const outerWhere = spans.find((span) => span.blockId === 'q1' && span.stage === 'WHERE')
    expect(outerWhere).toBeDefined()
    expect(SQL.slice(outerWhere!.start, outerWhere!.end)).toContain('salary > (SELECT')
    expect(outerWhere!.stageKey).toBe('WHERE')
    const outerSelect = spans.find((span) => span.blockId === 'q1' && span.stage === 'SELECT')
    expect(SQL.slice(outerSelect!.start, outerSelect!.end)).toBe('SELECT name ')
  })

  it('attributes inner clauses to the nested block with real ranges', () => {
    const innerWhere = spans.find((span) => span.blockId === 'q2' && span.stage === 'WHERE')
    expect(innerWhere).toBeDefined()
    expect(SQL.slice(innerWhere!.start, innerWhere!.end)).toBe('WHERE budget > 50000')
    expect(innerWhere!.stageKey).toBe('q2:WHERE')

    const innerSelect = spans.find((span) => span.blockId === 'q2' && span.stage === 'SELECT')
    expect(SQL.slice(innerSelect!.start, innerSelect!.end)).toBe('SELECT AVG(budget) ')
    const innerFrom = spans.find((span) => span.blockId === 'q2' && span.stage === 'FROM')
    expect(SQL.slice(innerFrom!.start, innerFrom!.end)).toBe('FROM departments ')
  })

  it('resolves spanOfStage by block identity', () => {
    expect(SQL.slice(spanOfStage(spans, 'WHERE')!.start, spanOfStage(spans, 'WHERE')!.end)).toContain(
      'salary >',
    )
    const inner = spanOfStage(spans, 'WHERE', 'q2')!
    expect(SQL.slice(inner.start, inner.end)).toBe('WHERE budget > 50000')
  })

  it('keeps Monaco positions accurate for the inner WHERE', () => {
    const singleLine = mapQueryClauses(SQL, {
      nestedQueries: [block('q2', INNER_SQL)],
      rootBlockId: 'q1',
    })
    const innerWhere = singleLine.find((span) => span.blockId === 'q2' && span.stage === 'WHERE')!
    expect(innerWhere.lineStart).toBe(1)
    expect(innerWhere.columnStart).toBe(innerWhere.start + 1)
  })
})

describe('mapQueryClauses — multiple occurrences and blocks', () => {
  it('keeps two SELECT clauses and two subquery blocks distinct', () => {
    const sql =
      'SELECT name FROM employees WHERE salary > (SELECT AVG(budget) FROM departments) AND age > (SELECT MIN(budget) FROM departments)'
    const spans = mapQueryClauses(sql, {
      nestedQueries: [
        block('q2', 'SELECT AVG(budget) FROM departments'),
        block('q3', 'SELECT MIN(budget) FROM departments'),
      ],
      rootBlockId: 'q1',
    })
    const selects = spans.filter((span) => span.stage === 'SELECT')
    expect(selects.map((span) => span.blockId)).toEqual(['q1', 'q2', 'q3'])
    const whiles = spans.filter((span) => span.stage === 'WHERE')
    // Root WHERE plus one WHERE per subquery is absent here (no inner WHERE),
    // so exactly one outer WHERE is mapped.
    expect(whiles.map((span) => span.blockId)).toEqual(['q1'])
    expect(spanOfStage(spans, 'SELECT', 'q2')?.stageKey).toBe('q2:SELECT')
    expect(spanOfStage(spans, 'SELECT', 'q3')?.stageKey).toBe('q3:SELECT')
  })
})
