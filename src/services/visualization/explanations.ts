/**
 * Explanation engine (Stage 2, Milestone 6 — explanation side).
 *
 * Generates stage explanations from the actual stage data (row counts,
 * group keys, conditions) — never a generic paragraph, and never claims
 * an operation happened if it did not. Three learning levels let the
 * same stage be explained at different depths, with links to trusted
 * documentation (SQLite's official docs) for further reading.
 */

import type { StageSnapshot, VisualizedStage } from '../../types/visualization'

export type LearningLevel = 'beginner' | 'intermediate' | 'advanced'

export const LEARNING_LEVELS: { id: LearningLevel; label: string }[] = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'intermediate', label: 'Intermediate' },
  { id: 'advanced', label: 'Advanced' },
]

/** Trusted documentation, keyed by the stages they cover. */
export interface DocSource {
  label: string
  url: string
  stages: VisualizedStage[]
}

export const DOC_SOURCES: DocSource[] = [
  {
    label: 'SQLite: SELECT (FROM → LIMIT order)',
    url: 'https://www.sqlite.org/lang_select.html',
    stages: ['FROM', 'JOIN', 'WHERE', 'GROUP_BY', 'HAVING', 'SELECT', 'DISTINCT', 'ORDER_BY', 'LIMIT'],
  },
  {
    label: 'SQLite: NULL handling and three-valued logic',
    url: 'https://www.sqlite.org/nulls.html',
    stages: ['WHERE', 'HAVING', 'SELECT'],
  },
  {
    label: 'SQLite: aggregate functions',
    url: 'https://www.sqlite.org/lang_aggfunc.html',
    stages: ['GROUP_BY', 'HAVING', 'SELECT'],
  },
  {
    label: 'SQLite: ORDER BY and collation',
    url: 'https://www.sqlite.org/lang_select.html#orderby',
    stages: ['ORDER_BY'],
  },
  {
    label: 'SQLite: SELECT DISTINCT',
    url: 'https://www.sqlite.org/lang_select.html#distinct',
    stages: ['DISTINCT'],
  },
  {
    label: 'SQLite: LIMIT and OFFSET',
    url: 'https://www.sqlite.org/lang_select.html#limitoffset',
    stages: ['LIMIT'],
  },
  {
    label: 'SQLite: compound SELECT (UNION / UNION ALL)',
    url: 'https://www.sqlite.org/lang_select.html#compound',
    stages: ['COMPOUND'],
  },
]

/** Human-readable stage titles. */
export const STAGE_TITLES: Record<VisualizedStage, string> = {
  FROM: 'FROM — load the source table',
  JOIN: 'JOIN — combine tables',
  WHERE: 'WHERE — filter rows',
  GROUP_BY: 'GROUP BY — collect rows into groups',
  HAVING: 'HAVING — filter groups',
  SELECT: 'SELECT — project columns',
  DISTINCT: 'DISTINCT — remove duplicates',
  COMPOUND: 'COMPOUND — combine SELECT branches',
  ORDER_BY: 'ORDER BY — sort the result',
  LIMIT: 'LIMIT — keep the first rows',
}

/** The conceptual (static) explanation per stage — level-specific. */
const CONCEPTS: Record<VisualizedStage, Record<LearningLevel, string>> = {
  FROM: {
    beginner:
      'FROM names the table your data comes from. SQL first pulls all of its rows out of the table, then every other clause works on that pile of rows.',
    intermediate:
      'FROM establishes the source row set. Logically, the FROM table (or joined tables) is materialized first; all later clauses operate on it.',
    advanced:
      'SQLite performs table scans or index lookups to produce the FROM row set. The visualization shows the logical model — SQLite may stream rows lazily, but the result is equivalent.',
  },
  JOIN: {
    beginner:
      'JOIN pairs rows of two tables that satisfy a condition. INNER JOIN keeps only matching pairs; LEFT JOIN also keeps left rows without a match, filling missing columns with NULL.',
    intermediate:
      'The ON condition is evaluated per candidate row pair. INNER JOIN emits pairs where the condition is true; LEFT JOIN additionally emits each unmatched left row extended with NULLs.',
    advanced:
      'SQLite implements joins as nested loops (block nested loop or index-based lookups when an index is usable). The simulator mirrors the logical semantics, not SQLite’s physical loop order.',
  },
  WHERE: {
    beginner:
      'WHERE checks every row against a condition. Rows that pass continue; rows that fail are thrown away. If a value is NULL, the answer is "unknown", and unknown rows are also thrown away.',
    intermediate:
      'WHERE is a per-row filter evaluated with three-valued logic: TRUE keeps the row, FALSE and UNKNOWN (NULL) drop it. NULL comparisons never evaluate to TRUE.',
    advanced:
      'SQLite evaluates predicates with its own opcode loop; comparison against NULL yields NULL, and only TRUE passes. Expressions like `NOT x IS NULL` are equivalent to `x IS NOT NULL`.',
  },
  GROUP_BY: {
    beginner:
      'GROUP BY collects rows that share the same value(s) into buckets. After grouping, one row exists per bucket, and aggregate functions like COUNT or AVG compute a value for each bucket.',
    intermediate:
      'GROUP BY partitions the filtered rows by the grouping expressions. Aggregates are evaluated per partition; a NULL key forms its own group because NULLs are compared for grouping equality.',
    advanced:
      'SQLite may satisfy GROUP BY with an index scan on the grouping columns or by sorting. Note: unlike standard SQL, SQLite permits selecting bare columns alongside aggregates — it picks an arbitrary row from each group (the simulator deterministically shows the first).',
  },
  HAVING: {
    beginner:
      'HAVING filters groups, not rows. It runs after grouping, so it can use aggregate results like AVG(salary) — something WHERE cannot do.',
    intermediate:
      'HAVING applies a predicate to each group after aggregation. Groups whose condition is FALSE or UNKNOWN are discarded.',
    advanced:
      'SQLite evaluates HAVING after each group’s aggregates are computed; with no GROUP BY, the entire result is treated as one group. HAVING may reference aggregates even when they are not in the SELECT list.',
  },
  SELECT: {
    beginner:
      'SELECT decides which columns appear in the final answer. It can also compute new values (like salary * 2) and rename them with aliases.',
    intermediate:
      'SELECT projects each remaining row (or group) to the output columns, evaluating expressions left to right and applying aliases. Aliases are not visible to other clauses except ORDER BY.',
    advanced:
      'Projection happens late in the logical pipeline: WHERE/GROUP BY/HAVING see the underlying rows, not the aliases. SQLite computes result column names from the expression text unless an alias is given.',
  },
  DISTINCT: {
    beginner:
      'DISTINCT removes duplicate rows, so every row in the result is unique. Rows are compared across all output columns.',
    intermediate:
      'DISTINCT deduplicates the projected output as a whole. Two rows are duplicates only if every column matches — including NULL, which counts as equal to NULL here.',
    advanced:
      'SQLite implements DISTINCT via a temporary B-tree or hash of the projected tuples. DISTINCT applies after projection, so `SELECT DISTINCT a, b` deduplicates the (a, b) pairs.',
  },
  ORDER_BY: {
    beginner:
      'ORDER BY sorts the result rows. ASC is smallest first (the default), DESC is largest first. Rows with equal values keep their relative order.',
    intermediate:
      'ORDER BY sorts by one or more keys, each ASC or DESC. NULLs sort before all values ascending and after them descending. Keys may reference output aliases, ordinals, or source columns.',
    advanced:
      'SQLite sorts with a B-tree or external merge for large sets and applies collation rules for text. Ties are not guaranteed to keep any particular order — the simulator shows a stable order, but only untied orders are validated against SQLite.',
  },
  COMPOUND: {
    beginner:
      'UNION stacks the rows of two or more SELECT statements. UNION removes rows that appear more than once; UNION ALL keeps every row, including duplicates.',
    intermediate:
      'Each SELECT branch is evaluated independently, then the branches are combined left to right. Every branch must return the same number of columns, and the first branch determines the output column names. NULLs compare equal when UNION removes duplicates.',
    advanced:
      'Compound operators are left-associative: A UNION B UNION ALL C means (A UNION B) UNION ALL C. UNION deduplicates the whole accumulated result, not just the incoming branch. The simulator folds branches in that order and marks which rows UNION removed.',
  },
  LIMIT: {
    beginner:
      'LIMIT keeps only the first N rows of the sorted result. OFFSET skips rows first — LIMIT 3 OFFSET 1 skips one row, then keeps three.',
    intermediate:
      'LIMIT truncates the output after ORDER BY, so it keeps the "top N" when combined with sorting. OFFSET discards the first M rows before applying the limit.',
    advanced:
      'In SQLite, `LIMIT x OFFSET y` and `LIMIT y, x` are equivalent forms (the comma form puts OFFSET first). LIMIT applies to the final ordered row set; with no ORDER BY, "first N" is whatever order SQLite produces.',
  },
}

/** Why the stage exists in the pipeline (one line each). */
const WHY: Record<VisualizedStage, string> = {
  FROM: 'Every query needs a source of rows.',
  JOIN: 'Answers often need data from more than one table.',
  WHERE: 'Questions usually concern only some rows.',
  GROUP_BY: 'Aggregate answers need per-bucket computation.',
  HAVING: 'Groups themselves may need filtering.',
  SELECT: 'The output must contain exactly the requested columns.',
  DISTINCT: 'Duplicates in projected output are usually unwanted.',
  COMPOUND: 'Some questions need rows from more than one independent SELECT.',
  ORDER_BY: 'Users expect results in a meaningful order.',
  LIMIT: 'Top-N results are the most common read pattern.',
}

/** What happened in this stage, derived from the real snapshot. */
function describeSnapshot(stage: VisualizedStage, snapshot: StageSnapshot): string {
  const removed = snapshot.removedRows.length
  const output = snapshot.outputRowCount
  switch (stage) {
    case 'FROM':
      return snapshot.truncated
        ? `Loaded ${output} rows for visualization (the real table has more; SQLite still reads all of them).`
        : `Loaded ${output} row${output === 1 ? '' : 's'} from the source table.`
    case 'JOIN':
      return `The join produced ${output} combined row${output === 1 ? '' : 's'}.`
    case 'WHERE':
      return removed === 0
        ? `All ${output} row${output === 1 ? '' : 's'} passed the condition — nothing was filtered out.`
        : `${output} row${output === 1 ? '' : 's'} passed; ${removed} ${removed === 1 ? 'was' : 'were'} filtered out.`
    case 'GROUP_BY': {
      const groupCount = snapshot.groups.length
      return groupCount === 0
        ? 'No rows remained to group.'
        : `Rows were collected into ${groupCount} group${groupCount === 1 ? '' : 's'}.`
    }
    case 'HAVING':
      return removed === 0
        ? `All ${output} group${output === 1 ? '' : 's'} satisfied the condition.`
        : `${output} group${output === 1 ? '' : 's'} remained; ${removed} ${removed === 1 ? 'was' : 'were'} removed.`
    case 'SELECT':
      return `Projected ${snapshot.columns.length} column${snapshot.columns.length === 1 ? '' : 's'} for ${output} row${output === 1 ? '' : 's'}.`
    case 'DISTINCT':
      return removed === 0
        ? 'No duplicate rows existed — the result is unchanged.'
        : `Removed ${removed} duplicate row${removed === 1 ? '' : 's'}; ${output} unique row${output === 1 ? '' : 's'} remain.`
    case 'COMPOUND':
      return removed === 0
        ? `Combined the branch results into ${output} row${output === 1 ? '' : 's'} without removing duplicates.`
        : `Combined the branch results into ${output} row${output === 1 ? '' : 's'}; UNION removed ${removed} duplicate row${removed === 1 ? '' : 's'}.`
    case 'ORDER_BY':
      return `All ${output} row${output === 1 ? '' : 's'} were rearranged into sorted order.`
    case 'LIMIT':
      return removed === 0
        ? `Kept all ${output} row${output === 1 ? '' : 's'} — the limit did not remove anything.`
        : `Skipped ${removed} row${removed === 1 ? '' : 's'} (OFFSET) and kept ${output}.`
  }
}

export interface StageExplanation {
  /** Title shown in the pipeline, e.g. "WHERE — filter rows". */
  title: string
  /** Concept explanation at the requested learning level. */
  concept: string
  /** One-line motivation for the stage. */
  why: string
  /** What actually happened, derived from the snapshot. */
  observation: string
  /** The snapshot's own generated explanation text. */
  detail: string
  /** Rows before/after this stage. */
  rowsBefore: number
  rowsAfter: number
}

/**
 * Build the explanation panel content for a completed stage snapshot at
 * a given learning level.
 */
export function explainStage(
  stage: VisualizedStage,
  snapshot: StageSnapshot,
  level: LearningLevel,
): StageExplanation {
  return {
    title: STAGE_TITLES[stage],
    concept: CONCEPTS[stage][level],
    why: WHY[stage],
    observation: describeSnapshot(stage, snapshot),
    detail: snapshot.explanation,
    rowsBefore: snapshot.inputRowCount,
    rowsAfter: snapshot.outputRowCount,
  }
}

/** Documentation links relevant to a stage. */
export function docsForStage(stage: VisualizedStage): DocSource[] {
  return DOC_SOURCES.filter((source) => source.stages.includes(stage))
}

/**
 * Optional knowledge check per stage (beginner/intermediate only).
 * Returns null when no check exists for the stage/level combination.
 */
export interface KnowledgeCheck {
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

export function knowledgeCheckFor(
  stage: VisualizedStage,
  level: LearningLevel,
): KnowledgeCheck | null {
  if (level === 'advanced') return null
  const checks: Partial<Record<VisualizedStage, KnowledgeCheck>> = {
    WHERE: {
      question: 'A row where the condition evaluates to UNKNOWN (because a value is NULL) is…',
      options: ['kept in the result', 'filtered out', 'shown with a warning'],
      correctIndex: 1,
      explanation: 'SQLite (and standard SQL) treat UNKNOWN as false in WHERE, so the row does not pass.',
    },
    GROUP_BY: {
      question: 'After GROUP BY department_id, how many output rows exist per distinct department value?',
      options: ['One', 'One per input row', 'It depends on COUNT'],
      correctIndex: 0,
      explanation: 'GROUP BY collapses all rows sharing a key into a single row per key.',
    },
    HAVING: {
      question: 'Which clause can use aggregate functions like AVG(salary) as a filter?',
      options: ['WHERE', 'HAVING', 'Both'],
      correctIndex: 1,
      explanation: 'WHERE filters rows before grouping; HAVING filters groups after aggregation.',
    },
    DISTINCT: {
      question: 'SELECT DISTINCT city FROM employees removes duplicates based on…',
      options: ['the city column only', 'all selected columns', 'the primary key'],
      correctIndex: 1,
      explanation: 'DISTINCT considers the entire projected row; with one selected column, that column alone decides.',
    },
    ORDER_BY: {
      question: 'With ORDER BY salary ASC, where do NULL salaries appear?',
      options: ['First', 'Last', 'They are removed'],
      correctIndex: 0,
      explanation: 'SQLite sorts NULLs smallest: first ascending, last descending.',
    },
    LIMIT: {
      question: 'LIMIT 3 OFFSET 2 returns…',
      options: ['rows 3–4', 'rows 1–3 of the result', 'rows 3–5 (skipping 2 first)'],
      correctIndex: 2,
      explanation: 'OFFSET 2 skips the first two rows, then LIMIT 3 keeps the next three.',
    },
  }
  return checks[stage] ?? null
}
