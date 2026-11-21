/**
 * SQLite value semantics shared by the expression evaluator and the
 * simulator (Stage 8C).
 *
 * This module owns the three pieces of SQLite behaviour the logical
 * simulator must reproduce to agree with real execution:
 *
 * 1. Declared-type affinity derivation (datatype3.html §3.1).
 * 2. Comparison-time affinity application (§4.1) and storage-class
 *    ordering (§4.2), including BLOB byte comparison.
 * 3. `BINARY` / ASCII-only `NOCASE` collation comparison.
 *
 * Values are never rewritten in place: the affinity helpers return a
 * value used only for one comparison, so stored rows keep their storage
 * class (and therefore their row identity).
 */

/** SQLite's five type-affinity categories. */
export type SqliteAffinity = 'INTEGER' | 'TEXT' | 'REAL' | 'NUMERIC' | 'BLOB'

/** Collations the simulator can reproduce faithfully. */
export type CollationName = 'BINARY' | 'NOCASE'

/**
 * Per-column metadata that travels with a relation. `affinity: null`
 * means "no reliably inferable affinity" (a computed expression, or a
 * fixture without schema metadata) — not BLOB affinity.
 */
export interface ColumnMeta {
  affinity: SqliteAffinity | null
  collation: CollationName
  /**
   * A column-declared collation the simulator cannot reproduce (e.g.
   * `COLLATE RTRIM`). Schema metadata only; consulting this column for a
   * collation-sensitive operation aborts with a clear reason instead of
   * silently using BINARY.
   */
  unsupportedCollation?: string
}

/** Metadata used for a value whose affinity is unknown. */
export const UNKNOWN_COLUMN_META: ColumnMeta = { affinity: null, collation: 'BINARY' }

/** Storage class order used by SQLite comparisons (NULL handled by callers). */
function storageClassRank(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return 0
  }
  if (typeof value === 'string') return 1
  if (value instanceof Uint8Array) return 2
  // Anything else (dates, plain objects) is not produced by SQLite reads;
  // treat it as text so it never beats a real storage class silently.
  return 1
}

/**
 * Derive SQLite affinity from a declared column type using the substring
 * rules in priority order. `CHARINT` contains both CHAR and INT: the INT
 * rule is checked first, so it is INTEGER — an exact-name mapping would
 * get this wrong.
 */
export function deriveAffinity(declaredType: string): SqliteAffinity {
  const type = declaredType.toLowerCase()
  if (type.includes('int')) return 'INTEGER'
  if (type.includes('char') || type.includes('clob') || type.includes('text')) return 'TEXT'
  if (type.includes('blob') || type.trim() === '') return 'BLOB'
  if (type.includes('real') || type.includes('floa') || type.includes('doub')) return 'REAL'
  return 'NUMERIC'
}

/** Normalize a collation name, or null when it is not supported. */
export function normalizeCollation(name: string): CollationName | null {
  const normalized = name.trim().toUpperCase()
  if (normalized === 'BINARY') return 'BINARY'
  if (normalized === 'NOCASE') return 'NOCASE'
  return null
}

const WELL_FORMED_NUMERIC =
  /^[ \t\n\r]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r]*$/

/** Does the whole string (modulo surrounding whitespace) form a number? */
export function isWellFormedNumericText(value: string): boolean {
  return WELL_FORMED_NUMERIC.test(value)
}

/**
 * Format a REAL value the way SQLite converts REAL → TEXT: 15 significant
 * digits, always with a decimal point or exponent (`%!.15g`).
 */
export function sqliteRealToText(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Inf'
  if (value === Number.NEGATIVE_INFINITY) return '-Inf'
  if (value === 0) return '0.0'

  const match = /^(-?)(\d)\.(\d+)e([+-]\d+)$/.exec(value.toExponential(14))
  if (match === null) return String(value)
  const sign = match[1] ?? ''
  const exponent = Number(match[4])
  let digits = `${match[2] ?? ''}${match[3] ?? ''}`.replace(/0+$/, '')
  if (digits === '') digits = '0'

  if (exponent < -4 || exponent >= 15) {
    const mantissa = digits.length === 1 ? `${digits}.0` : `${digits[0]}.${digits.slice(1)}`
    const exponentSign = exponent < 0 ? '-' : '+'
    const exponentDigits = Math.abs(exponent).toString().padStart(2, '0')
    return `${sign}${mantissa}e${exponentSign}${exponentDigits}`
  }

  const pointPosition = exponent + 1
  if (pointPosition <= 0) {
    return `${sign}0.${'0'.repeat(-pointPosition)}${digits}`
  }
  if (pointPosition >= digits.length) {
    return `${sign}${digits}${'0'.repeat(pointPosition - digits.length)}.0`
  }
  return `${sign}${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`
}

/** Text SQLite produces for a numeric value under TEXT affinity. */
export function numberToSqliteText(value: number | bigint, kind?: 'integer' | 'real'): string {
  if (typeof value === 'bigint') return value.toString()
  if (kind === 'integer' || (kind === undefined && Number.isInteger(value))) {
    return Number.isSafeInteger(value) ? value.toString() : sqliteRealToText(value)
  }
  return sqliteRealToText(value)
}

/**
 * Apply NUMERIC affinity to one comparison operand: well-formed numeric
 * text becomes a number; everything else is unchanged (including text
 * such as `'12abc'`, which SQLite keeps as TEXT).
 */
export function applyNumericAffinity(value: unknown, kind?: 'integer' | 'real'): unknown {
  if (typeof value === 'string' && isWellFormedNumericText(value)) {
    return Number(value.trim())
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'bigint') return Number(value)
  if (kind === 'real' && typeof value === 'number') return value
  return value
}

/** Apply TEXT affinity to one comparison operand. */
export function applyTextAffinity(value: unknown, kind?: 'integer' | 'real'): unknown {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return numberToSqliteText(value, kind)
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  return value
}

/** ASCII-only lowercasing, matching SQLite NOCASE (never Unicode case folding). */
export function asciiLowerCase(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase())
}

function compareTextByCollation(a: string, b: string, collation: CollationName): number {
  const left = collation === 'NOCASE' ? asciiLowerCase(a) : a
  const right = collation === 'NOCASE' ? asciiLowerCase(b) : b
  return left < right ? -1 : left > right ? 1 : 0
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    if (left !== right) return left < right ? -1 : 1
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0
}

/**
 * Compare two non-NULL values with SQLite storage-class ordering:
 * numbers < text < blobs, numeric comparison inside numbers, collation
 * comparison inside text, byte comparison inside blobs.
 */
export function compareValues(a: unknown, b: unknown, collation: CollationName = 'BINARY'): number {
  const rankA = storageClassRank(a)
  const rankB = storageClassRank(b)
  if (rankA !== rankB) return rankA < rankB ? -1 : 1

  if (rankA === 0) {
    const left = typeof a === 'bigint' ? Number(a) : Number(a)
    const right = typeof b === 'bigint' ? Number(b) : Number(b)
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (rankA === 1) {
    const left = typeof a === 'string' ? a : String(a)
    const right = typeof b === 'string' ? b : String(b)
    return compareTextByCollation(left, right, collation)
  }
  return compareBytes(a as Uint8Array, b as Uint8Array)
}

/** Normalize one value for a collation-aware equality key (GROUP/DISTINCT). */
export function normalizeKeyValue(value: unknown, collation: CollationName): unknown {
  return collation === 'NOCASE' && typeof value === 'string' ? asciiLowerCase(value) : value
}
