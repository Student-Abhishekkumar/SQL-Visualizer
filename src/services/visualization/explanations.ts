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
    label: 'SQLite: compound SELECT (set operations)',
    url: 'https://www.sqlite.org/lang_select.html#compound',
    stages: ['COMPOUND'],
  },
  {
    label: 'SQLite: CREATE TABLE',
    url: 'https://www.sqlite.org/lang_createtable.html',
    stages: ['DATABASE', 'TABLE_DEFINITION', 'COLUMN_DEFINITIONS', 'CONSTRAINTS', 'CREATE_TABLE', 'RESULTING_SCHEMA'],
  },
  {
    label: 'SQLite: ALTER TABLE',
    url: 'https://www.sqlite.org/lang_altertable.html',
    stages: ['ORIGINAL_SCHEMA', 'ALTER_OPERATION', 'SCHEMA_TRANSFORMATION', 'RESULTING_SCHEMA'],
  },
  {
    label: 'SQLite: CREATE INDEX and DROP INDEX',
    url: 'https://www.sqlite.org/lang_createindex.html',
    stages: ['INDEX_DEFINITION', 'CREATE_INDEX', 'INDEX_METADATA', 'EXISTING_INDEX', 'DROP_INDEX', 'REMAINING_INDEXES'],
  },
  {
    label: 'SQLite: DROP TABLE',
    url: 'https://www.sqlite.org/lang_droptable.html',
    stages: ['DROP_TABLE', 'REMOVED_TABLE', 'REMAINING_SCHEMA'],
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
  TARGET: 'TARGET — open the target table',
  INPUT: 'INPUT — gather incoming rows',
  COLUMN_MAPPING: 'COLUMN MAPPING — align input to columns',
  INSERT: 'INSERT — add new rows',
  MATCHED_ROWS: 'MATCHED ROWS — find affected rows',
  SET: 'SET — compute new values',
  CHANGED_ROWS: 'CHANGED ROWS — rows that differ',
  UNCHANGED_ROWS: 'UNCHANGED ROWS — rows already equal',
  DELETE: 'DELETE — remove matched rows',
  RETAINED_ROWS: 'RETAINED ROWS — rows left behind',
  FINAL_TABLE: 'FINAL TABLE — resulting table state',
  DATABASE: 'DATABASE — inspect the catalog',
  TABLE_DEFINITION: 'TABLE DEFINITION — read the CREATE SQL',
  COLUMN_DEFINITIONS: 'COLUMN DEFINITIONS — inspect columns',
  CONSTRAINTS: 'CONSTRAINTS — inspect keys and indexes',
  CREATE_TABLE: 'CREATE TABLE — add a table definition',
  ORIGINAL_SCHEMA: 'ORIGINAL SCHEMA — capture the starting object',
  ALTER_OPERATION: 'ALTER OPERATION — describe the schema change',
  SCHEMA_TRANSFORMATION: 'SCHEMA TRANSFORMATION — inspect changed columns',
  RESULTING_SCHEMA: 'RESULTING SCHEMA — read the resulting catalog',
  DROP_TABLE: 'DROP TABLE — remove a table definition',
  REMOVED_TABLE: 'REMOVED TABLE — inspect the removed definition',
  REMAINING_SCHEMA: 'REMAINING SCHEMA — inspect surviving objects',
  INDEX_DEFINITION: 'INDEX DEFINITION — read the index SQL',
  CREATE_INDEX: 'CREATE INDEX — add an index definition',
  INDEX_METADATA: 'INDEX METADATA — inspect keys and uniqueness',
  EXISTING_INDEX: 'EXISTING INDEX — capture the starting index',
  DROP_INDEX: 'DROP INDEX — remove an index definition',
  REMAINING_INDEXES: 'REMAINING INDEXES — inspect surviving indexes',
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
      'UNION combines rows and removes duplicates, UNION ALL keeps every row, INTERSECT keeps rows present in both inputs, and EXCEPT keeps left rows that are absent from the right input.',
    intermediate:
      'Each SELECT branch is evaluated independently, then operators run left to right. INTERSECT and EXCEPT compare complete rows with NULL-safe distinct semantics; the first branch determines output column names.',
    advanced:
      'Compound operators are left-associative: A UNION B INTERSECT C means (A UNION B) INTERSECT C. The simulator records each operation’s accumulated left input, next right input, retained rows, excluded rows and duplicates without claiming SQLite’s physical execution plan.',
  },
  LIMIT: {
    beginner:
      'LIMIT keeps only the first N rows of the sorted result. OFFSET skips rows first — LIMIT 3 OFFSET 1 skips one row, then keeps three.',
    intermediate:
      'LIMIT truncates the output after ORDER BY, so it keeps the "top N" when combined with sorting. OFFSET discards the first M rows before applying the limit.',
    advanced:
      'In SQLite, `LIMIT x OFFSET y` and `LIMIT y, x` are equivalent forms (the comma form puts OFFSET first). LIMIT applies to the final ordered row set; with no ORDER BY, "first N" is whatever order SQLite produces.',
  },
  TARGET: {
    beginner:
      'TARGET is the table the statement changes. The preview shows this table inside a temporary copy of the database, not your real one.',
    intermediate:
      'The target table is resolved and its columns, declared types and defaults are read from the isolated copy. Every later DML stage operates on this table only.',
    advanced:
      'DML visualization never executes on the active connection. The target is resolved from sqlite_master on a byte-for-byte clone, and previews that would fan out (triggers, cascading foreign keys) are rejected.',
  },
  INPUT: {
    beginner:
      'INPUT is the data being added: literal VALUES, the result of an INSERT … SELECT, or DEFAULT VALUES.',
    intermediate:
      'The incoming rows are produced before any write happens. For INSERT … SELECT the source query is simulated and validated on the isolated copy first.',
    advanced:
      'Input rows are evaluated with SQLite affinity rules applied at storage time. The simulator predicts each row, then real execution on the clone confirms it.',
  },
  COLUMN_MAPPING: {
    beginner:
      'COLUMN MAPPING pairs each incoming value with the target column that will receive it. Columns left out get their declared default or NULL.',
    intermediate:
      'Positional or named columns are matched case-insensitively to insertable target columns. Omitted columns are filled from defaults; INTEGER PRIMARY KEY values are assigned by SQLite.',
    advanced:
      'Generated columns are rejected because their values cannot be predicted faithfully. The mapping is shown explicitly so a mismatched column count or name is visible before execution.',
  },
  INSERT: {
    beginner:
      'INSERT adds the mapped rows to the table. Only the newly added rows are shown here.',
    intermediate:
      'The isolated copy executes the real INSERT; the rows reported are the ones that actually appeared compared with the pre-statement snapshot.',
    advanced:
      'Affected-row counts come from sql.js `rowsModified`. The preview never persists: the clone is discarded after the trace is built.',
  },
  MATCHED_ROWS: {
    beginner:
      'MATCHED ROWS are the rows the WHERE condition selects. Only these rows can be updated or deleted.',
    intermediate:
      'The condition is evaluated per row with SQLite three-valued logic; rows evaluating to UNKNOWN are not matched. Unmatched rows are shown as removed from this stage.',
    advanced:
      'Matching is computed on the isolated copy using the same affinity and collation metadata SQLite uses, then confirmed against real execution.',
  },
  SET: {
    beginner:
      'SET computes each new value for the matched rows. SQLite evaluates every assignment against the row’s original values.',
    intermediate:
      'All SET expressions see the pre-update row, so assignments do not see each other’s changes. Storage affinity is applied to each computed value.',
    advanced:
      'Assignment to the INTEGER PRIMARY KEY / rowid column is rejected because it changes stable row identity. The predicted values are compared with the isolated copy’s actual rows.',
  },
  CHANGED_ROWS: {
    beginner:
      'CHANGED ROWS are matched rows whose stored values differ after the update.',
    intermediate:
      'A row is changed only when its full value tuple differs from before; matched rows that already held the assigned values are reported separately.',
    advanced:
      'Change detection uses collision-safe row identity and storage-class-aware equality, so a value that only changes type (for example integer to text) still counts as changed.',
  },
  UNCHANGED_ROWS: {
    beginner:
      'UNCHANGED ROWS matched the condition but already had the assigned values, so nothing about them changed.',
    intermediate:
      'These rows were affected by the statement in the sense that SQLite processed them, but their stored values stayed identical.',
    advanced:
      'Separating changed from unchanged rows explains why an UPDATE can report affected rows without visibly altering data.',
  },
  DELETE: {
    beginner:
      'DELETE removes the matched rows. Only the removed rows are shown here.',
    intermediate:
      'The isolated copy executes the real DELETE; the rows shown are the ones that actually disappeared compared with the pre-statement snapshot.',
    advanced:
      'Deletion counts come from sql.js `rowsModified`. Foreign-key cascade actions are rejected so no row outside the target table can change.',
  },
  RETAINED_ROWS: {
    beginner:
      'RETAINED ROWS are the rows that remain after the delete because they did not match.',
    intermediate:
      'These rows are the table’s surviving contents in the isolated copy after the statement runs.',
    advanced:
      'Retained rows are read back from the clone, not inferred, so the final table reflects real SQLite state.',
  },
  FINAL_TABLE: {
    beginner:
      'FINAL TABLE is what the table would look like after the statement. It comes from a temporary copy — your real database is unchanged.',
    intermediate:
      'The final table is read from the isolated copy after execution and validated against the simulator’s prediction. The active database and its stored snapshot are untouched.',
    advanced:
      'The preview discards the clone in a `finally` block on success and failure. Validation compares predicted final rows with the clone’s actual rows; a mismatch is reported honestly.',
  },
  DATABASE: {
    beginner: 'DATABASE shows the tables, indexes, views and triggers currently known to SQLite.',
    intermediate: 'The catalog rows come directly from sqlite_master on the isolated copy before or after DDL.',
    advanced: 'Automatic constraint indexes are retained in the catalog so UNIQUE and PRIMARY KEY side effects remain visible.',
  },
  TABLE_DEFINITION: {
    beginner: 'TABLE DEFINITION shows the table name and the CREATE TABLE SQL SQLite stored.',
    intermediate: 'The displayed SQL comes from sqlite_master, not from reconstructing or formatting the input statement.',
    advanced: 'The row count is read separately from the cloned table, making IF NOT EXISTS no-op definitions explicit.',
  },
  COLUMN_DEFINITIONS: {
    beginner: 'COLUMN DEFINITIONS lists each column with its type, default and key information.',
    intermediate: 'PRAGMA table_xinfo supplies declared types, nullability, primary-key positions and defaults, including generated columns.',
    advanced: 'Affinity follows SQLite’s ordered declared-type substring rules; single-column uniqueness is derived from real indexes.',
  },
  CONSTRAINTS: {
    beginner: 'CONSTRAINTS shows indexes and foreign keys attached to the table.',
    intermediate: 'PRAGMA index_list, index_xinfo and foreign_key_list provide uniqueness, origin, key order and referential actions.',
    advanced: 'Expression index keys remain null in structured metadata and are labelled as expressions only for display.',
  },
  CREATE_TABLE: {
    beginner: 'CREATE TABLE adds a new table definition in the temporary preview database.',
    intermediate: 'SQLite executes the real statement on a byte-copy clone, then the trace reads back the stored definition.',
    advanced: 'Existing-table errors and IF NOT EXISTS no-ops are distinguished; neither path executes on or persists to the active connection.',
  },
  ORIGINAL_SCHEMA: {
    beginner: 'ORIGINAL SCHEMA is the object as it existed before the change.',
    intermediate: 'Before metadata and table rows are captured on the clone before any DDL executes.',
    advanced: 'Keeping the complete before image allows the preview to verify preservation instead of merely claiming it.',
  },
  ALTER_OPERATION: {
    beginner: 'ALTER OPERATION identifies the one table rename, column rename, add or drop being performed.',
    intermediate: 'The conservative classifier accepts exactly one SQLite ALTER action and rejects batches or schema-qualified targets.',
    advanced: 'The original SQL remains attached to this stage while execution is deferred to the isolated SQLite connection.',
  },
  SCHEMA_TRANSFORMATION: {
    beginner: 'SCHEMA TRANSFORMATION shows the columns after ALTER TABLE.',
    intermediate: 'SQLite supplies the new definitions; renames preserve every row and ADD/DROP COLUMN preserves every surviving column.',
    advanced: 'Complete before/after row multisets are compared. Any unexpected data change discards the preview rather than producing a trace.',
  },
  RESULTING_SCHEMA: {
    beginner: 'RESULTING SCHEMA shows what the database would contain after the statement.',
    intermediate: 'The final catalog and object metadata are fresh SQLite reads from the isolated post-statement database.',
    advanced: 'No preview bytes are exported or persisted; the temporary connection closes immediately after the trace is complete.',
  },
  DROP_TABLE: {
    beginner: 'DROP TABLE removes a table definition in the temporary preview database.',
    intermediate: 'The isolated SQLite execution also removes dependent indexes and triggers, which the remaining catalog reveals.',
    advanced: 'Foreign-key delete actions that could mutate other tables are rejected before execution; ordinary SQLite failures remain errors.',
  },
  REMOVED_TABLE: {
    beginner: 'REMOVED TABLE keeps the old table definition visible so you can see what was dropped.',
    intermediate: 'Its CREATE SQL and row count come from the pre-drop sqlite_master and table reads.',
    advanced: 'Row-data change is reported only for an actual drop, never for a missing-table IF EXISTS no-op.',
  },
  REMAINING_SCHEMA: {
    beginner: 'REMAINING SCHEMA lists the objects left after a drop.',
    intermediate: 'The complete post-drop catalog proves that the target and its dependent entries no longer exist.',
    advanced: 'The active catalog is not queried for this after image; it comes exclusively from the isolated clone.',
  },
  INDEX_DEFINITION: {
    beginner: 'INDEX DEFINITION shows the index SQL, owning table and indexed keys.',
    intermediate: 'SQLite stores the authoritative CREATE INDEX SQL while PRAGMA supplies uniqueness and key metadata.',
    advanced: 'Expression keys are represented honestly as null rather than being assigned invented column names.',
  },
  CREATE_INDEX: {
    beginner: 'CREATE INDEX adds an index in the temporary preview without changing any table rows.',
    intermediate: 'The preview supports ordinary, UNIQUE, expression and partial indexes on one main-database table.',
    advanced: 'IF NOT EXISTS uses SQLite’s real existing object, even when the same-named index belongs to another table.',
  },
  INDEX_METADATA: {
    beginner: 'INDEX METADATA explains whether the index is unique and which columns or expressions it uses.',
    intermediate: 'PRAGMA index_list distinguishes created, UNIQUE-constraint and PRIMARY KEY indexes; index_xinfo orders the keys.',
    advanced: 'The preview compares complete before/after row multisets so index creation cannot be mistaken for a data transformation.',
  },
  EXISTING_INDEX: {
    beginner: 'EXISTING INDEX shows the index before DROP INDEX removes it.',
    intermediate: 'The index and owning table are resolved case-insensitively from the cloned SQLite catalog.',
    advanced: 'DROP INDEX has a dedicated conservative lexer because the installed SQL parser does not support this SQLite statement.',
  },
  DROP_INDEX: {
    beginner: 'DROP INDEX removes only the index definition; the table and all of its rows remain.',
    intermediate: 'The statement executes on the isolated clone and the after image confirms the index is gone.',
    advanced: 'IF EXISTS on a missing index produces an explicit no-op trace rather than a fabricated removed-index row.',
  },
  REMAINING_INDEXES: {
    beginner: 'REMAINING INDEXES lists the indexes still attached to the table.',
    intermediate: 'Every surviving entry comes from PRAGMA index_list after the isolated drop.',
    advanced: 'Row preservation is checked across the operation, and the active database’s indexes are never altered.',
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
  TARGET: 'A DML statement changes exactly one target table.',
  INPUT: 'New rows have to come from somewhere.',
  COLUMN_MAPPING: 'Values must land in the right columns.',
  INSERT: 'The point of INSERT is to add rows.',
  MATCHED_ROWS: 'Only some rows should be affected.',
  SET: 'Updated columns need new values.',
  CHANGED_ROWS: 'Only genuinely different rows are interesting.',
  UNCHANGED_ROWS: 'Matched rows may already hold the new values.',
  DELETE: 'The point of DELETE is to remove rows.',
  RETAINED_ROWS: 'The table survives with its remaining rows.',
  FINAL_TABLE: 'The result is the table’s new state.',
  DATABASE: 'DDL changes a schema, so the starting catalog matters.',
  TABLE_DEFINITION: 'SQLite stores the authoritative table definition in sqlite_master.',
  COLUMN_DEFINITIONS: 'Declared types, defaults and key flags explain the table structure.',
  CONSTRAINTS: 'Constraints and indexes are part of the real schema, not just the CREATE text.',
  CREATE_TABLE: 'The statement’s purpose is to add a table definition.',
  ORIGINAL_SCHEMA: 'A schema transformation needs an accurate before image.',
  ALTER_OPERATION: 'ALTER TABLE performs one explicit structural action.',
  SCHEMA_TRANSFORMATION: 'The resulting columns reveal exactly what changed.',
  RESULTING_SCHEMA: 'The after image proves which catalog objects now exist.',
  DROP_TABLE: 'The statement’s purpose is to remove a table definition.',
  REMOVED_TABLE: 'The pre-drop definition makes the removal understandable.',
  REMAINING_SCHEMA: 'Dependent indexes and triggers can disappear with a table.',
  INDEX_DEFINITION: 'The stored SQL and owning table define the index.',
  CREATE_INDEX: 'The statement adds an index without changing table rows.',
  INDEX_METADATA: 'SQLite’s PRAGMA metadata describes how the index is structured.',
  EXISTING_INDEX: 'Dropping an index requires its real before image.',
  DROP_INDEX: 'The statement removes an index without changing table rows.',
  REMAINING_INDEXES: 'Other indexes on the owning table survive independently.',
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
      return snapshot.explanation
    case 'ORDER_BY':
      return `All ${output} row${output === 1 ? '' : 's'} were rearranged into sorted order.`
    case 'LIMIT':
      return removed === 0
        ? `Kept all ${output} row${output === 1 ? '' : 's'} — the limit did not remove anything.`
        : `Skipped ${removed} row${removed === 1 ? '' : 's'} (OFFSET) and kept ${output}.`
    case 'TARGET':
      return `The target table holds ${output} row${output === 1 ? '' : 's'} in the isolated copy before the statement runs.`
    case 'INPUT':
      return `${output} input row${output === 1 ? '' : 's'} are available to map into the target table.`
    case 'COLUMN_MAPPING':
      return `${output} column mapping${output === 1 ? '' : 's'} align input values with target columns.`
    case 'INSERT':
      return `${output} row${output === 1 ? '' : 's'} were inserted in the isolated copy.`
    case 'MATCHED_ROWS':
      return removed === 0
        ? `All ${output} row${output === 1 ? '' : 's'} matched the condition.`
        : `${output} row${output === 1 ? '' : 's'} matched; ${removed} did not and are left untouched.`
    case 'SET':
      return `New values were computed for ${output} matched row${output === 1 ? '' : 's'}.`
    case 'CHANGED_ROWS':
      return `${output} matched row${output === 1 ? '' : 's'} stored different values.`
    case 'UNCHANGED_ROWS':
      return `${output} matched row${output === 1 ? '' : 's'} already held the assigned values.`
    case 'DELETE':
      return `${output} row${output === 1 ? '' : 's'} were deleted in the isolated copy.`
    case 'RETAINED_ROWS':
      return `${output} row${output === 1 ? '' : 's'} remain after the delete.`
    case 'FINAL_TABLE':
      return `The isolated table ends with ${output} row${output === 1 ? '' : 's'}; your active database is unchanged.`
    case 'DATABASE':
    case 'RESULTING_SCHEMA':
    case 'REMAINING_SCHEMA':
      return `SQLite reports ${output} catalog object${output === 1 ? '' : 's'} at this point in the isolated preview.`
    case 'TABLE_DEFINITION':
    case 'REMOVED_TABLE':
      return output === 0 ? 'No table definition exists at this point.' : 'The real table definition and row count come from sqlite_master and SQLite row reads.'
    case 'COLUMN_DEFINITIONS':
    case 'SCHEMA_TRANSFORMATION':
      return `PRAGMA table_xinfo reports ${output} column${output === 1 ? '' : 's'}.`
    case 'CONSTRAINTS':
      return `SQLite reports ${output} index or foreign-key metadata row${output === 1 ? '' : 's'}.`
    case 'CREATE_TABLE':
      return 'CREATE TABLE completed in the isolated copy; the active schema is unchanged.'
    case 'ORIGINAL_SCHEMA':
    case 'EXISTING_INDEX':
      return `The before image contains ${output} schema metadata row${output === 1 ? '' : 's'}.`
    case 'ALTER_OPERATION':
      return 'One ALTER TABLE action was classified and applied to the isolated copy.'
    case 'DROP_TABLE':
      return 'DROP TABLE completed in the isolated copy; dependent catalog entries are visible in the remaining schema.'
    case 'INDEX_DEFINITION':
    case 'INDEX_METADATA':
      return output === 0 ? 'No index metadata exists at this point.' : 'The index definition, uniqueness, origin and keys come from SQLite.'
    case 'CREATE_INDEX':
      return 'CREATE INDEX completed without changing table rows in the isolated copy.'
    case 'DROP_INDEX':
      return 'DROP INDEX completed without changing table rows in the isolated copy.'
    case 'REMAINING_INDEXES':
      return `The owning table retains ${output} index${output === 1 ? '' : 'es'}.`
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
