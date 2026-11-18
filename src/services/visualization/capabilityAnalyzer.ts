/**
 * Visualization capability analyzer (Stage 2, Milestone 2.2).
 *
 * Decides whether the logical simulator can faithfully visualize a
 * parsed SELECT. The analyzer is conservative: whenever the simulator
 * would have to guess at SQLite semantics (e.g. bare columns in an
 * aggregate query without GROUP BY), the query is reported as
 * unsupported or carries an explicit warning — never silently simulated.
 */

import type {
  AggregateCall,
  Expression,
  InterpretationResult,
} from './astInterpreter'
import type { DetectedConstruct, VisualizedStage, VisualizationCapability } from '../../types/visualization'

/** Row-count thresholds used to classify visualization cost. */
const SMALL_TABLE = 1_000
const LARGE_TABLE = 50_000

function isAggregateExpression(expr: Expression): boolean {
  switch (expr.kind) {
    case 'aggregate':
      return true
    case 'logical':
    case 'comparison':
    case 'arithmetic':
      return isAggregateExpression(expr.left) || isAggregateExpression(expr.right)
    case 'not':
    case 'unary_minus':
      return isAggregateExpression(expr.operand)
    case 'in_subquery':
      return isAggregateExpression(expr.left)
    case 'exists_subquery':
      return false
    default:
      return false
  }
}

/** Walk an expression tree and collect the operators actually used. */
function collectOperators(expr: Expression | null, operators: Set<string>): void {
  if (expr === null) return
  switch (expr.kind) {
    case 'comparison':
      operators.add(expr.operator)
      collectOperators(expr.left, operators)
      collectOperators(expr.right, operators)
      break
    case 'logical':
      operators.add(expr.operator)
      collectOperators(expr.left, operators)
      collectOperators(expr.right, operators)
      break
    case 'arithmetic':
      operators.add(expr.operator)
      collectOperators(expr.left, operators)
      collectOperators(expr.right, operators)
      break
    case 'not':
      operators.add('NOT')
      collectOperators(expr.operand, operators)
      break
    case 'unary_minus':
      collectOperators(expr.operand, operators)
      break
    case 'in_subquery':
      operators.add(expr.operator)
      collectOperators(expr.left, operators)
      break
    case 'exists_subquery':
      operators.add(expr.negated ? 'NOT EXISTS' : 'EXISTS')
      break
    default:
      break
  }
}

/** Build the ordered list of stages this query would run through. */
function supportedStagesFor(hasJoin: boolean, hasWhere: boolean, hasGroupBy: boolean, hasHaving: boolean, hasDistinct: boolean, hasOrderBy: boolean, hasLimit: boolean): VisualizedStage[] {
  const stages: VisualizedStage[] = ['FROM']
  if (hasJoin) stages.push('JOIN')
  if (hasWhere) stages.push('WHERE')
  if (hasGroupBy) stages.push('GROUP_BY')
  if (hasHaving) stages.push('HAVING')
  stages.push('SELECT')
  if (hasDistinct) stages.push('DISTINCT')
  if (hasOrderBy) stages.push('ORDER_BY')
  if (hasLimit) stages.push('LIMIT')
  return stages
}

function aggregateLabel(call: AggregateCall): string {
  return call.text
}

/**
 * Analyze an interpretation result and produce the capability contract.
 * Optionally pass table row counts (name → count) to refine the
 * complexity estimate; counts for unknown tables are ignored.
 */
export function analyzeCapability(
  interpretation: InterpretationResult,
  tableSizes?: Record<string, number>,
): VisualizationCapability {
  const structure = interpretation.structure
  const unsupportedFeatures: DetectedConstruct[] = interpretation.unsupportedReasons.map(
    (reason) => ({ kind: 'unsupported', detail: reason }),
  )

  if (structure === null) {
    return {
      supported: false,
      supportedStages: [],
      unsupportedFeatures,
      warnings: [],
      detected: [],
      isReadOnly: false,
      hasAggregation: false,
      hasJoin: false,
      estimatedComplexity: 'unknown',
      unsupportedReason: interpretation.unsupportedReasons[0] ?? 'The query cannot be interpreted.',
    }
  }

  const detected: DetectedConstruct[] = []
  const warnings: DetectedConstruct[] = []

  // --- compound SELECT (UNION / UNION ALL) --------------------------------
  // The synthetic compound root has no FROM of its own; every fact worth
  // reporting comes from its independent SELECT branches.
  if (structure.compound !== null) {
    const branches = structure.compound.branches
    const operators = branches
      .slice(1)
      .map((branch) => branch.operator ?? 'UNION')
    detected.push({
      kind: 'compound',
      detail: `${branches.length} SELECT branches combined with ${[...new Set(operators)].join(', ')}`,
    })
    if (structure.ctes.length > 0) {
      detected.push({
        kind: 'cte',
        detail: `${structure.ctes.length} common table expression${structure.ctes.length === 1 ? '' : 's'}: ${structure.ctes
          .map((cte) => cte.name)
          .join(', ')}`,
      })
    }
    for (const [index, branch] of branches.entries()) {
      const query = branch.query
      const tables = [query.from.name, ...query.joins.map((join) => join.table.name)]
        .filter((name) => name !== '')
      if (tables.length > 0) {
        detected.push({
          kind: 'source-table',
          detail: `branch ${index + 1}: ${tables.join(', ')}`,
        })
      }
      for (const join of query.joins) {
        detected.push({ kind: 'join', detail: `branch ${index + 1}: ${join.type} on ${join.table.name}` })
      }
      if (query.aggregates.length > 0) {
        detected.push({
          kind: 'aggregation',
          detail: `branch ${index + 1}: ${[...new Set(query.aggregates.map(aggregateLabel))].join(', ')}`,
        })
      }
    }
    if (structure.orderBy.length > 0) {
      detected.push({
        kind: 'order-by',
        detail: `compound: ${structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', ')}`,
      })
    }
    if (structure.limit !== null) {
      detected.push({ kind: 'limit', detail: `compound: ${structure.limit.text}` })
    }

    let estimatedComplexity: VisualizationCapability['estimatedComplexity'] = 'unknown'
    if (tableSizes !== undefined) {
      const sizes = branches.flatMap((branch) =>
        [branch.query.from.name, ...branch.query.joins.map((join) => join.table.name)]
          .map((name) => tableSizes[name])
          .filter((size): size is number => typeof size === 'number'),
      )
      if (sizes.length > 0) {
        const product = sizes.reduce((acc, size) => acc * size, 1)
        estimatedComplexity = product <= SMALL_TABLE ? 'small' : product <= LARGE_TABLE ? 'medium' : 'large'
      }
    }

    const supported = unsupportedFeatures.length === 0
    const stages: VisualizedStage[] = ['COMPOUND']
    if (structure.orderBy.length > 0) stages.push('ORDER_BY')
    if (structure.limit !== null) stages.push('LIMIT')

    return {
      supported,
      supportedStages: supported ? stages : [],
      unsupportedFeatures,
      warnings,
      detected,
      isReadOnly: true,
      hasAggregation: branches.some((branch) => branch.query.aggregates.length > 0),
      hasJoin: branches.some((branch) => branch.query.joins.length > 0),
      estimatedComplexity,
      unsupportedReason: supported ? undefined : unsupportedFeatures[0]?.detail,
    }
  }

  // --- detect constructs -------------------------------------------------
  detected.push({
    kind: 'source-table',
    detail: structure.joins.length > 0
      ? `${structure.from.name} joined with ${structure.joins.map((join) => join.table.name).join(', ')}`
      : structure.from.name,
  })

  if (structure.ctes.length > 0) {
    detected.push({
      kind: 'cte',
      detail: `${structure.ctes.length} common table expression${structure.ctes.length === 1 ? '' : 's'}: ${structure.ctes
        .map((cte) => cte.name)
        .join(', ')}`,
    })
  }

  for (const join of structure.joins) {
    detected.push({ kind: 'join', detail: `${join.type} on ${join.table.name}` })
  }

  if (structure.subqueries.length > 0) {
    detected.push({
      kind: 'subquery',
      detail: `${structure.subqueries.length} nested ${structure.subqueries.length === 1 ? 'query block' : 'query blocks'}: ${structure.subqueries
        .map((subquery) => subquery.text)
        .join(', ')}`,
    })
  }

  if (structure.selectAll) {
    detected.push({ kind: 'select-all', detail: 'SELECT *' })
  } else {
    detected.push({
      kind: 'projection',
      detail: `${structure.selectItems.length} column${structure.selectItems.length === 1 ? '' : 's'}`,
    })
  }

  const operators = new Set<string>()
  collectOperators(structure.where, operators)
  collectOperators(structure.having, operators)
  for (const op of operators) {
    detected.push({ kind: 'operator', detail: op })
  }

  if (structure.groupBy.length > 0) {
    detected.push({
      kind: 'group-by',
      detail: structure.groupBy.map((expr) => expr.text).join(', '),
    })
  }

  const aggregates = structure.aggregates
  if (aggregates.length > 0) {
    detected.push({
      kind: 'aggregation',
      detail: [...new Set(aggregates.map(aggregateLabel))].join(', '),
    })
  }

  if (structure.distinct) {
    detected.push({ kind: 'distinct', detail: 'DISTINCT' })
  }
  if (structure.orderBy.length > 0) {
    detected.push({
      kind: 'order-by',
      detail: structure.orderBy.map((term) => `${term.text} ${term.direction}`).join(', '),
    })
  }
  if (structure.limit !== null) {
    detected.push({
      kind: 'limit',
      detail: structure.limit.text,
    })
  }

  // --- conservative warnings ---------------------------------------------
  const hasGroupBy = structure.groupBy.length > 0
  const selectHasAggregate = structure.selectItems.some((item) => isAggregateExpression(item.expression))

  if (selectHasAggregate && !hasGroupBy) {
    // SQLite implicitly collapses to one group; the simulator does the
    // same, but the bare-column behavior of unaggregated select items
    // is implementation-defined — surface it.
    const hasBareColumns = structure.selectItems.some(
      (item) => item.expression.kind === 'column' || item.expression.kind === 'star',
    )
    warnings.push({
      kind: 'implicit-aggregation',
      detail: hasBareColumns
        ? 'The query mixes aggregate functions with plain columns and no GROUP BY. SQLite picks an arbitrary row for the plain columns; the simulation shows one representative row.'
        : 'The query aggregates over the whole table with no GROUP BY — the simulation will show a single group.',
    })
  }

  if (structure.having !== null && !hasGroupBy && !selectHasAggregate) {
    warnings.push({
      kind: 'having-without-group-by',
      detail: 'HAVING without GROUP BY treats the whole result as one group (SQLite behavior).',
    })
  }

  // --- complexity estimate -------------------------------------------------
  let estimatedComplexity: VisualizationCapability['estimatedComplexity'] = 'unknown'
  if (tableSizes !== undefined) {
    const sizes = [structure.from.name, ...structure.joins.map((join) => join.table.name)]
      .map((name) => tableSizes[name])
      .filter((size): size is number => typeof size === 'number')
    if (sizes.length > 0) {
      const product = sizes.reduce((acc, size) => acc * size, 1)
      estimatedComplexity = product <= SMALL_TABLE ? 'small' : product <= LARGE_TABLE ? 'medium' : 'large'
    }
  }

  const supported = unsupportedFeatures.length === 0
  const hasJoin = structure.joins.length > 0
  const hasWhere = structure.where !== null
  const hasHaving = structure.having !== null
  const hasOrderBy = structure.orderBy.length > 0
  const hasLimit = structure.limit !== null

  return {
    supported,
    supportedStages: supported
      ? supportedStagesFor(hasJoin, hasWhere, hasGroupBy, hasHaving, structure.distinct, hasOrderBy, hasLimit)
      : [],
    unsupportedFeatures,
    warnings,
    detected,
    isReadOnly: true,
    hasAggregation: aggregates.length > 0,
    hasJoin,
    estimatedComplexity,
    unsupportedReason: supported ? undefined : unsupportedFeatures[0]?.detail,
  }
}
