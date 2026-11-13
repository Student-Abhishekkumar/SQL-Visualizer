import { describe, expect, it } from 'vitest'
import { interpretExpression } from './astInterpreter'
import {
  EvaluationError,
  evaluateAggregate,
  evaluateCondition,
  evaluateExpression,
  likeToRegex,
  toSqliteNumber,
  type RowContext,
} from './expressionEvaluator'

/** Build an expression through the real interpreter from a raw parser AST. */
function expr(raw: unknown) {
  const parsed = interpretExpression(raw)
  if (parsed === null) throw new Error(`interpretExpression returned null for ${JSON.stringify(raw)}`)
  return parsed
}

/** Raw parser node shapes (what interpretExpression consumes). */
const lit = (value: number) => ({ type: 'number', value })
const str = (value: string) => ({ type: 'single_quote_string', value })
const nullNode = { type: 'null', value: null }
const col = (name: string, table: string | null = null) => ({ type: 'column_ref', table, column: name })
const numList = (values: number[]) => ({ type: 'expr_list', value: values.map((v) => lit(v)) })

const cmp = (operator: string, left: unknown, right: unknown) => ({
  type: 'binary_expr', operator, left, right,
})

function ctxOf(columns: string[], values: unknown[], aggregates?: Record<string, unknown>): RowContext {
  return { columns, values, aggregates }
}

describe('evaluateCondition — comparisons', () => {
  const salaryAbove = expr(cmp('>', col('salary'), lit(50000)))

  it('evaluates a simple numeric comparison', () => {
    expect(evaluateCondition(salaryAbove, ctxOf(['salary'], [62000]))).toBe('true')
    expect(evaluateCondition(salaryAbove, ctxOf(['salary'], [40000]))).toBe('false')
  })

  it('returns unknown when a comparison operand is NULL', () => {
    expect(evaluateCondition(salaryAbove, ctxOf(['salary'], [null]))).toBe('unknown')
  })

  it('compares strings lexically', () => {
    const inDelhi = expr(cmp('=', col('city'), str('Delhi')))
    expect(evaluateCondition(inDelhi, ctxOf(['city'], ['Delhi']))).toBe('true')
    expect(evaluateCondition(inDelhi, ctxOf(['city'], ['Mumbai']))).toBe('false')
  })

  it('treats numbers as smaller than text like SQLite type ordering', () => {
    const numberBeforeText = expr(cmp('<', lit(10), str('abc')))
    expect(evaluateCondition(numberBeforeText, ctxOf([], []))).toBe('true')
  })

  it('resolves qualified columns and is case-insensitive', () => {
    const condition = expr(cmp('=', col('salary', 'e'), lit(50000)))
    expect(evaluateCondition(condition, ctxOf(['e.salary'], [50000]))).toBe('true')
    expect(evaluateCondition(condition, ctxOf(['e.salary'], [50001]))).toBe('false')
  })

  it('throws on unknown columns with an explanatory message', () => {
    const condition = expr(cmp('>', col('wage'), lit(1)))
    expect(() => evaluateCondition(condition, ctxOf(['salary'], [1]))).toThrow(EvaluationError)
    expect(() => evaluateCondition(condition, ctxOf(['salary'], [1]))).toThrow(/Unknown column/)
  })
})

describe('evaluateCondition — three-valued logic', () => {
  const knownTrue = cmp('>', col('salary'), lit(0))
  const knownFalse = cmp('>', col('salary'), lit(100000))
  const unknownCmp = cmp('>', col('age'), lit(0))

  it('AND: unknown propagates', () => {
    const and = expr({ type: 'binary_expr', operator: 'AND', left: knownTrue, right: unknownCmp })
    expect(evaluateCondition(and, ctxOf(['salary', 'age'], [60000, null]))).toBe('unknown')
  })

  it('AND short-circuits false even when the right side is unknown', () => {
    const and = expr({ type: 'binary_expr', operator: 'AND', left: knownFalse, right: unknownCmp })
    expect(evaluateCondition(and, ctxOf(['salary', 'age'], [60000, null]))).toBe('false')
  })

  it('OR: true dominates, unknown propagates', () => {
    const orTrue = expr({ type: 'binary_expr', operator: 'OR', left: cmp('=', col('city'), str('Delhi')), right: unknownCmp })
    expect(evaluateCondition(orTrue, ctxOf(['city', 'age'], ['Delhi', null]))).toBe('true')

    const orUnknown = expr({ type: 'binary_expr', operator: 'OR', left: cmp('=', col('city'), str('Delhi')), right: unknownCmp })
    expect(evaluateCondition(orUnknown, ctxOf(['city', 'age'], ['Mumbai', null]))).toBe('unknown')
  })

  it('NOT unknown is unknown — NOT x IS NULL pattern', () => {
    const notIsNull = expr({
      type: 'unary_expr', operator: 'NOT',
      expr: cmp('IS', col('salary'), nullNode),
    })
    expect(evaluateCondition(notIsNull, ctxOf(['salary'], [null]))).toBe('false')
    expect(evaluateCondition(notIsNull, ctxOf(['salary'], [50000]))).toBe('true')
  })
})

describe('evaluateCondition — IS NULL / IS NOT NULL', () => {
  const isNull = expr(cmp('IS', col('age'), nullNode))
  it('detects NULL with IS', () => {
    expect(evaluateCondition(isNull, ctxOf(['age'], [null]))).toBe('true')
    expect(evaluateCondition(isNull, ctxOf(['age'], [30]))).toBe('false')
  })

  it('IS NOT inverts with null-safe semantics', () => {
    const isNotNull = expr(cmp('IS NOT', col('age'), nullNode))
    expect(evaluateCondition(isNotNull, ctxOf(['age'], [null]))).toBe('false')
    expect(evaluateCondition(isNotNull, ctxOf(['age'], [30]))).toBe('true')
  })
})

describe('evaluateCondition — IN / NOT IN', () => {
  it('matches a value inside the list', () => {
    const condition = expr(cmp('IN', col('department_id'), numList([1, 2])))
    expect(evaluateCondition(condition, ctxOf(['department_id'], [2]))).toBe('true')
    expect(evaluateCondition(condition, ctxOf(['department_id'], [3]))).toBe('false')
  })

  it('returns unknown for NULL left operand', () => {
    const condition = expr(cmp('IN', col('department_id'), numList([1, 2])))
    expect(evaluateCondition(condition, ctxOf(['department_id'], [null]))).toBe('unknown')
  })

  it('returns unknown when the list contains NULL and nothing matched', () => {
    const withNull = expr(cmp('IN', col('department_id'), { type: 'expr_list', value: [lit(1), nullNode] }))
    expect(evaluateCondition(withNull, ctxOf(['department_id'], [9]))).toBe('unknown')
    const plain = expr(cmp('IN', col('department_id'), numList([1, 2])))
    expect(evaluateCondition(plain, ctxOf(['department_id'], [9]))).toBe('false')
  })

  it('NOT IN inverts matches and keeps unknown', () => {
    const notIn = expr(cmp('NOT IN', col('department_id'), numList([1, 2])))
    expect(evaluateCondition(notIn, ctxOf(['department_id'], [3]))).toBe('true')
    expect(evaluateCondition(notIn, ctxOf(['department_id'], [1]))).toBe('false')
    expect(evaluateCondition(notIn, ctxOf(['department_id'], [null]))).toBe('unknown')
  })
})

describe('evaluateCondition — BETWEEN', () => {
  const between = expr(cmp('BETWEEN', col('salary'), numList([40000, 70000])))
  it('is inclusive on both bounds', () => {
    expect(evaluateCondition(between, ctxOf(['salary'], [40000]))).toBe('true')
    expect(evaluateCondition(between, ctxOf(['salary'], [70000]))).toBe('true')
    expect(evaluateCondition(between, ctxOf(['salary'], [39999]))).toBe('false')
    expect(evaluateCondition(between, ctxOf(['salary'], [null]))).toBe('unknown')
  })

  it('NOT BETWEEN inverts inside, keeps unknown', () => {
    const notBetween = expr(cmp('NOT BETWEEN', col('salary'), numList([40000, 70000])))
    expect(evaluateCondition(notBetween, ctxOf(['salary'], [50000]))).toBe('false')
    expect(evaluateCondition(notBetween, ctxOf(['salary'], [80000]))).toBe('true')
    expect(evaluateCondition(notBetween, ctxOf(['salary'], [null]))).toBe('unknown')
  })
})

describe('evaluateCondition — LIKE', () => {
  const likeR = expr(cmp('LIKE', col('name'), str('R%')))
  it('matches % and _ wildcards, case-insensitively', () => {
    expect(evaluateCondition(likeR, ctxOf(['name'], ['Ravi']))).toBe('true')
    expect(evaluateCondition(likeR, ctxOf(['name'], ['ravi']))).toBe('true')
    expect(evaluateCondition(likeR, ctxOf(['name'], ['Priya']))).toBe('false')
  })

  it('returns unknown for NULL operands', () => {
    expect(evaluateCondition(likeR, ctxOf(['name'], [null]))).toBe('unknown')
  })

  it('likeToRegex treats . as a literal dot, % and _ as wildcards', () => {
    expect(likeToRegex('a.b%').test('a.bccc')).toBe(true)
    expect(likeToRegex('a.b%').test('axbccc')).toBe(false)
    expect(likeToRegex('100%').test('1000')).toBe(true) // % is a wildcard here
  })
})

describe('evaluateExpression — arithmetic', () => {
  it('computes arithmetic on columns and literals', () => {
    const doubled = expr(cmp('*', col('salary'), lit(2)))
    expect(evaluateExpression(doubled, ctxOf(['salary'], [45000]))).toBe(90000)
  })

  it('propagates NULL through arithmetic', () => {
    const sum = expr(cmp('+', col('bonus'), lit(100)))
    expect(evaluateExpression(sum, ctxOf(['bonus'], [null]))).toBeNull()
  })

  it('performs SQLite integer division for integer operands', () => {
    expect(evaluateExpression(expr(cmp('/', lit(7), lit(2))), ctxOf([], []))).toBe(3)
    // NOTE: the parser normalizes the literal 7.0 to the number 7, so a
    // REAL literal is indistinguishable at this layer; a non-integer
    // operand still produces float division.
    expect(evaluateExpression(expr(cmp('/', lit(7.5), lit(2))), ctxOf([], []))).toBe(3.75)
  })

  it('yields NULL for division and modulo by zero', () => {
    expect(evaluateExpression(expr(cmp('/', lit(7), lit(0))), ctxOf([], []))).toBeNull()
    expect(evaluateExpression(expr(cmp('%', lit(7), lit(0))), ctxOf([], []))).toBeNull()
  })

  it('coerces numeric-prefixed text like SQLite', () => {
    expect(toSqliteNumber('42abc')).toBe(42)
    expect(toSqliteNumber('hello')).toBe(0)
    expect(toSqliteNumber('  -3.5x')).toBe(-3.5)
  })
})

describe('evaluateExpression — aggregates', () => {
  it('returns pre-computed aggregate values from the context', () => {
    const agg = expr({ type: 'aggr_func', name: 'AVG', args: { expr: col('salary') } })
    expect(evaluateExpression(agg, ctxOf(['salary'], [1], { 'AVG(salary)': 52000 }))).toBe(52000)
  })

  it('throws when an aggregate has no pre-computed value', () => {
    const agg = expr({ type: 'aggr_func', name: 'AVG', args: { expr: col('salary') } })
    expect(() => evaluateExpression(agg, ctxOf(['salary'], [1]))).toThrow(/per group/)
  })
})

describe('evaluateAggregate — group semantics', () => {
  /** Rows of one group: salary column with some NULLs. */
  const salaries = (values: unknown[]): RowContext[] =>
    values.map((value) => ctxOf(['salary'], [value]))

  it('COUNT(*) counts every row including NULL-bearing rows', () => {
    const star = { name: 'COUNT' as const, argument: null, distinct: false, text: 'COUNT(*)' }
    expect(evaluateAggregate(star, salaries([100, null, 300]))).toBe(3)
    expect(evaluateAggregate(star, [])).toBe(0)
  })

  it('COUNT(col) skips NULLs', () => {
    const call = { name: 'COUNT' as const, argument: expr(col('salary')), distinct: false, text: 'COUNT(salary)' }
    expect(evaluateAggregate(call, salaries([100, null, 300]))).toBe(2)
    expect(evaluateAggregate(call, salaries([null, null]))).toBe(0)
  })

  it('COUNT(DISTINCT col) counts unique non-NULL values', () => {
    const call = {
      name: 'COUNT' as const,
      argument: expr(col('city')),
      distinct: true,
      text: 'COUNT(DISTINCT city)',
    }
    const rows = [
      ctxOf(['city'], ['Delhi']),
      ctxOf(['city'], ['Delhi']),
      ctxOf(['city'], [null]),
      ctxOf(['city'], ['Mumbai']),
    ]
    expect(evaluateAggregate(call, rows)).toBe(2)
  })

  it('SUM/AVG ignore NULLs and yield NULL on empty sets', () => {
    const sum = { name: 'SUM' as const, argument: expr(col('salary')), distinct: false, text: 'SUM(salary)' }
    const avg = { name: 'AVG' as const, argument: expr(col('salary')), distinct: false, text: 'AVG(salary)' }
    expect(evaluateAggregate(sum, salaries([100, null, 300]))).toBe(400)
    expect(evaluateAggregate(avg, salaries([100, null, 300]))).toBe(200)
    expect(evaluateAggregate(sum, salaries([null, null]))).toBeNull()
    expect(evaluateAggregate(avg, [])).toBeNull()
  })

  it('SUM(DISTINCT col) deduplicates before summing', () => {
    const call = { name: 'SUM' as const, argument: expr(col('salary')), distinct: true, text: 'SUM(DISTINCT salary)' }
    expect(evaluateAggregate(call, salaries([100, 100, 300]))).toBe(400)
  })

  it('MIN/MAX ignore NULLs and return the extreme value', () => {
    const min = { name: 'MIN' as const, argument: expr(col('salary')), distinct: false, text: 'MIN(salary)' }
    const max = { name: 'MAX' as const, argument: expr(col('salary')), distinct: false, text: 'MAX(salary)' }
    expect(evaluateAggregate(min, salaries([300, null, 100, 200]))).toBe(100)
    expect(evaluateAggregate(max, salaries([300, null, 100]))).toBe(300)
    expect(evaluateAggregate(min, salaries([null]))).toBeNull()
  })
})
