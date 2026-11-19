import { describe, expect, it } from 'vitest'
import { analyzeCapability } from './capabilityAnalyzer'
import { interpretQuery, structureText } from './astInterpreter'

function interpret(sql: string) {
  return interpretQuery(sql, [sql])
}

function structureOf(sql: string) {
  const result = interpret(sql)
  expect(result.unsupportedReasons).toEqual([])
  expect(result.structure).not.toBeNull()
  return result.structure!
}

describe('Stage 2 compound interpretation', () => {
  it.each(['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'] as const)(
    'interprets %s with a trailing semicolon',
    (operator) => {
      const structure = structureOf(`SELECT id FROM a ${operator} SELECT id FROM b;`)
      expect(structure.compound?.branches.map((branch) => branch.operator)).toEqual([
        null,
        operator,
      ])
      expect(structure.compound?.branches.map((branch) => branch.query.id)).toEqual(['q2', 'q3'])
      expect(structureText(structure)).toBe(`SELECT id FROM a ${operator} SELECT id FROM b`)
    },
  )

  it('preserves left-to-right operators and IDs in a mixed five-branch chain', () => {
    const sql =
      'SELECT id FROM a UNION SELECT id FROM b INTERSECT SELECT id FROM c EXCEPT SELECT id FROM d UNION ALL SELECT id FROM e'
    const structure = structureOf(sql)
    const branches = structure.compound!.branches
    expect(branches.map((branch) => branch.operator)).toEqual([
      null,
      'UNION',
      'INTERSECT',
      'EXCEPT',
      'UNION ALL',
    ])
    expect(branches.map((branch) => branch.query.id)).toEqual(['q2', 'q3', 'q4', 'q5', 'q6'])
    expect(branches.every((branch) => branch.query.parentId === 'q1')).toBe(true)
    expect(branches.every((branch) => branch.query.depth === 1)).toBe(true)
    expect(structureText(structure)).toBe(sql)
  })

  it('hoists root ORDER BY and LIMIT/OFFSET from the terminal branch', () => {
    const structure = structureOf(
      'SELECT id AS key FROM a INTERSECT SELECT id FROM b ORDER BY key DESC LIMIT 4 OFFSET 2;',
    )
    expect(structure.orderBy).toHaveLength(1)
    expect(structure.orderBy[0]).toMatchObject({ text: 'key', direction: 'DESC' })
    expect(structure.limit).toMatchObject({ limit: 4, offset: 2 })
    expect(structure.compound!.branches.every((branch) => branch.query.orderBy.length === 0)).toBe(true)
    expect(structure.compound!.branches.every((branch) => branch.query.limit === null)).toBe(true)
    expect(structureText(structure)).toBe(
      'SELECT id AS key FROM a INTERSECT SELECT id FROM b ORDER BY key DESC LIMIT 4 OFFSET 2',
    )
  })

  it('keeps root CTEs visible to every compound branch', () => {
    const structure = structureOf(
      'WITH x AS (SELECT id FROM a) SELECT id FROM x INTERSECT SELECT id FROM b UNION ALL SELECT id FROM x',
    )
    expect(structure.ctes.map((cte) => cte.query.id)).toEqual(['q2'])
    expect(structure.compound!.branches.map((branch) => branch.query.id)).toEqual(['q3', 'q4', 'q5'])
    expect(structure.compound!.branches.map((branch) => branch.query.from.name)).toEqual(['x', 'b', 'x'])
  })

  it('preserves scalar, IN and EXISTS blocks inside fallback branches', () => {
    const structure = structureOf(
      'SELECT id FROM a WHERE id = (SELECT MAX(id) FROM b) INTERSECT SELECT id FROM c WHERE id IN (SELECT id FROM d) EXCEPT SELECT id FROM e WHERE EXISTS (SELECT 1 FROM f)',
    )
    const branches = structure.compound!.branches
    expect(branches.map((branch) => branch.query.id)).toEqual(['q2', 'q4', 'q6'])
    expect(branches.map((branch) => branch.query.subqueries[0]?.query.blockKind)).toEqual([
      'scalar',
      'in',
      'exists',
    ])
    expect(branches.map((branch) => branch.query.subqueries[0]?.query.parentId)).toEqual([
      'q2',
      'q4',
      'q6',
    ])
  })

  it('returns splitter reasons for unsupported compound syntax', () => {
    for (const [sql, reason] of [
      ['SELECT id FROM a INTERSECT ALL SELECT id FROM b', 'INTERSECT ALL'],
      ['SELECT id FROM a EXCEPT ALL SELECT id FROM b', 'EXCEPT ALL'],
      ['SELECT id FROM a UNION DISTINCT SELECT id FROM b', 'UNION DISTINCT'],
      ['SELECT id FROM a ORDER BY id INTERSECT SELECT id FROM b', 'must follow the final set operator'],
    ] as const) {
      const result = interpret(sql)
      expect(result.structure).toBeNull()
      expect(result.unsupportedReasons.join(' ')).toContain(reason)
    }
  })

  it('leaves ordinary SELECT interpretation unchanged, including semicolons', () => {
    const result = interpret('SELECT id FROM a WHERE id > 0 ORDER BY id LIMIT 2;')
    expect(result.unsupportedReasons).toEqual([])
    expect(result.structure?.compound).toBeNull()
    expect(result.structure?.from.name).toBe('a')
    expect(result.structure?.limit).toMatchObject({ limit: 2, offset: 0 })
  })

  it('marks INTERSECT and EXCEPT as supported for Stage 3', () => {
    for (const operator of ['INTERSECT', 'EXCEPT'] as const) {
      const interpretation = interpret(`SELECT id FROM a ${operator} SELECT id FROM b`)
      expect(interpretation.unsupportedReasons).toEqual([])
      expect(analyzeCapability(interpretation).supported).toBe(true)
    }
  })
})
