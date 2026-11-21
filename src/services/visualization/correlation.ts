/**
 * Correlation detection (Stage 2, scalar subquery hardening).
 *
 * The interpreter can only see qualifiers, so it catches `outer.col`
 * references. Most correlated queries use unqualified names instead
 * (`WHERE budget > salary`), which can only be classified once real
 * table columns are known.
 *
 * This module resolves each column reference against the block's own
 * FROM/JOIN scope and then against its ancestors:
 *
 * - qualified ref outside the block scope        → correlated
 * - unqualified ref found only in an ancestor    → correlated
 * - unqualified ref found in the block scope     → local (SQL scoping)
 * - ref found nowhere                            → local; the simulator’s
 *   normal "unknown column" error is the honest result
 *
 * Correlated evaluation is intentionally NOT implemented yet: callers
 * abort the simulation with an explicit reason before producing any
 * trace, so unsupported correlated queries are never advertised as
 * supported.
 */

import type { Expression, QueryStructure } from './astInterpreter'
import type { TableData } from './simulator'

export interface CorrelationFinding {
  correlated: boolean
  /** The first offending reference, for the user-facing reason. */
  reference?: string
  /** True when the detection needed real column names. */
  schemaResolved?: boolean
}

interface ColumnReference {
  table: string | null
  name: string
}

function collectReferences(expr: Expression | null, out: ColumnReference[]): void {
  if (expr === null) return
  switch (expr.kind) {
    case 'column':
      out.push({ table: expr.table, name: expr.name })
      break
    case 'comparison':
    case 'logical':
    case 'arithmetic':
      collectReferences(expr.left, out)
      collectReferences(expr.right, out)
      break
    case 'not':
    case 'unary_minus':
      collectReferences(expr.operand, out)
      break
    case 'collate':
      collectReferences(expr.operand, out)
      break
    case 'aggregate':
      collectReferences(expr.call.argument, out)
      break
    case 'list':
      for (const item of expr.exprs) collectReferences(item, out)
      break
    case 'subquery':
      // A nested block has its own scope; its references are checked
      // when that block is evaluated.
      break
    case 'in_subquery':
      // The left operand belongs to this block; the subquery is its own scope.
      collectReferences(expr.left, out)
      break
    case 'exists_subquery':
      break
    default:
      break
  }
}

function referencesOf(structure: QueryStructure): ColumnReference[] {
  const references: ColumnReference[] = []
  for (const item of structure.selectItems) collectReferences(item.expression, references)
  collectReferences(structure.where, references)
  for (const expr of structure.groupBy) collectReferences(expr, references)
  collectReferences(structure.having, references)
  for (const term of structure.orderBy) collectReferences(term.expression, references)
  for (const join of structure.joins) collectReferences(join.on, references)
  return references
}

function tableRefsOf(structure: QueryStructure): Array<{ name: string; alias: string | null }> {
  return [structure.from, ...structure.joins.map((join) => join.table)]
}

function columnsOf(
  structure: QueryStructure,
  getTableData: (name: string) => TableData | null,
): Set<string> {
  const columns = new Set<string>()
  for (const table of tableRefsOf(structure)) {
    const data = getTableData(table.name)
    if (data === null) continue
    for (const column of data.columns) columns.add(column.toLowerCase())
  }
  return columns
}

function qualifiersOf(structure: QueryStructure): Set<string> {
  const qualifiers = new Set<string>()
  for (const table of tableRefsOf(structure)) {
    qualifiers.add(table.name.toLowerCase())
    if (table.alias !== null) qualifiers.add(table.alias.toLowerCase())
  }
  return qualifiers
}

/**
 * Classify a block against its ancestors using the real column names.
 * `ancestors` is outermost → innermost, and must include the direct
 * parent (the block itself is `inner`).
 */
export function detectCorrelation(
  inner: QueryStructure,
  ancestors: QueryStructure[],
  getTableData: (name: string) => TableData | null,
): CorrelationFinding {
  const innerQualifiers = qualifiersOf(inner)
  const innerColumns = columnsOf(inner, getTableData)
  const references = referencesOf(inner)

  // 1. Qualified references that leave the block's own scope.
  for (const reference of references) {
    if (reference.table === null) continue
    if (!innerQualifiers.has(reference.table.toLowerCase())) {
      return {
        correlated: true,
        reference: `${reference.table}.${reference.name}`,
        schemaResolved: false,
      }
    }
  }

  // 2. Unqualified references that only exist in an outer block.
  const ancestorColumns = ancestors.map((ancestor) => columnsOf(ancestor, getTableData))
  for (const reference of references) {
    if (reference.table !== null) continue
    const name = reference.name.toLowerCase()
    // SQL resolves an unqualified name to the innermost scope first, so
    // a name that exists locally is never correlated.
    if (innerColumns.has(name)) continue
    for (let index = ancestorColumns.length - 1; index >= 0; index--) {
      if (ancestorColumns[index]?.has(name)) {
        return { correlated: true, reference: reference.name, schemaResolved: true }
      }
    }
  }

  return { correlated: false }
}
