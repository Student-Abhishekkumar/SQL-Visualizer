/**
 * Collision-safe SQLite row identity and comparison helpers.
 *
 * `rowKey` is used for exact set/group identity. `valuesEqual` is the
 * parity comparator and intentionally keeps the existing small floating-
 * point tolerance for aggregate results. Ordered and unordered validation
 * both use `rowsEqual`/`rowsMatchUnordered`, so their semantics agree.
 */

const RELATIVE_EPSILON = 1e-9

function numberKey(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === 0) return '0'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  // Seventeen significant digits round-trip an IEEE-754 double without
  // relying on locale-specific or lossy display formatting.
  return value.toPrecision(17)
}

function bytesKey(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Type-tagged, unambiguous encoding for one SQLite value. */
function valueKey(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return `number:${numberKey(value)}`
  if (typeof value === 'string') return `string:${value.length}:${value}`
  if (typeof value === 'boolean') return `boolean:${value ? '1' : '0'}`
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (value instanceof Uint8Array) return `blob:${value.byteLength}:${bytesKey(value)}`
  throw new TypeError(`Unsupported SQLite value type: ${Object.prototype.toString.call(value)}`)
}

/** Canonical identity for a complete row, including column boundaries. */
export function rowKey(values: readonly unknown[]): string {
  return `[${values.map(valueKey).join('|')}]`
}

/** Strict type-aware equality with the documented parity float tolerance. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return true
    if (Number.isNaN(a) && Number.isNaN(b)) return true
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    const scale = Math.max(1, Math.abs(a), Math.abs(b))
    return Math.abs(a - b) <= RELATIVE_EPSILON * scale
  }
  return valueKey(a) === valueKey(b)
}

/** Compare two complete rows positionally, including their column counts. */
export function rowsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => valuesEqual(value, b[index]))
}

/** Multiset equality using the same comparator as ordered validation. */
export function rowsMatchUnordered(
  simulated: readonly (readonly unknown[])[],
  actual: readonly (readonly unknown[])[],
): boolean {
  if (simulated.length !== actual.length) return false
  const used = new Set<number>()
  for (const simulatedRow of simulated) {
    let match = -1
    for (let index = 0; index < actual.length; index++) {
      if (used.has(index)) continue
      if (rowsEqual(simulatedRow, actual[index] ?? [])) {
        match = index
        break
      }
    }
    if (match < 0) return false
    used.add(match)
  }
  return true
}
