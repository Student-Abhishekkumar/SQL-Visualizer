# Feature reference

This document is the detailed inventory of what SQL Visualizer actually does, what it supports only
partially, and what it does not do yet. The [README](../README.md) is the short product tour.

**Legend:** ✅ implemented · ◐ limited or conditional · — not implemented

## Query workspace

| Capability | Status | Details |
|:---|:---:|:---|
| Monaco SQL editor | ✅ | SQL syntax highlighting, schema-aware autocomplete and a resizable editor area. |
| Run SQL | ✅ | Executes the editor buffer, including multiple statements separated by semicolons. |
| Keyboard execution | ✅ | `Ctrl/Cmd + Enter` runs the current buffer. |
| Format SQL | ✅ | Formats the current statement with the built-in formatter. |
| Clear editor | ✅ | Clears the buffer without touching the database. |
| Example queries | ✅ | Toolbar menu with ready-made queries for the University example. |
| Visualize | ✅ | Builds a flow trace for a single supported `SELECT`. |
| Query / Canvas toggle | ✅ | Both views stay mounted; `Ctrl/Cmd + Shift + M` switches without losing state. |

## Results and history

| Capability | Status | Details |
|:---|:---:|:---|
| Results grid | ✅ | Real SQLite rows with sticky headers and row numbers. |
| Display types | ✅ | Columns are labelled `TEXT`, `NUM` or `BLOB` from the first non-null value. |
| Messages | ✅ | Success/error messages, including failing statement index. |
| Query information | ✅ | Statement types, total time, rows returned, rows modified, query length, referenced tables and SQLite version. |
| Query history | ✅ | Persists across refreshes, capped at 200 entries; stores SQL and metadata, never result sets. |
| History filtering | ✅ | Filter by the active database or show all databases. |
| Saved queries | ✅ | Named queries persisted in IndexedDB and tagged with the active database when one is open. |
| History maintenance | ✅ | Delete individual entries or clear all history from Settings. |

## Database workspace

| Capability | Status | Details |
|:---|:---:|:---|
| Multiple databases | ✅ | Independent SQLite files with their own schema. History and saved queries are tagged with the database they belong to. |
| Create from template | ✅ | Blank, University example, or custom setup SQL. |
| Open / switch | ✅ | The active database is remembered across reloads. |
| Rename / duplicate | ✅ | Metadata-only rename and a full copy of the database bytes. |
| Reset | ✅ | Replays the setup state for template databases; clears imported databases to empty. |
| Delete | ✅ | Removes database metadata and stored bytes. Existing history and saved queries remain tagged to the deleted database. |
| Export SQLite | ✅ | Downloads the database as a `.sqlite` file. |
| Export SQL | ✅ | Downloads a `.sql` script that recreates the exported database. |
| Import | ✅ | Accepts `.db`, `.sqlite`, `.sqlite3` and `.sql` scripts. |
| Schema explorer | ✅ | Tables, columns, row counts, keys, indexes and original `CREATE TABLE` SQL. |
| Persistent storage | ✅ | Database bytes, metadata, history and saved queries live in IndexedDB. |

<p align="center">
  <img src="assets/database-selector.png" alt="Database selector listing four independent databases" width="720" />
</p>

<p align="center"><sub>Switching databases keeps schemas separate; history entries and saved queries stay tagged to the database they came from.</sub></p>

## Visualization

| Capability | Status | Details |
|:---|:---:|:---|
| Single `SELECT` visualization | ◐ | Other statements execute normally but cannot be visualized. |
| Logical pipeline | ✅ | `FROM`, `JOIN`, `WHERE`, `GROUP BY`, `HAVING`, `SELECT`, `DISTINCT`, `ORDER BY`, `LIMIT` / `OFFSET`. |
| Stage snapshots | ✅ | Immutable snapshots with output rows, removed rows and input/output counts, including filtered and skipped rows. |
| Playback | ✅ | Play, pause, previous, next, seek, restart and jump to end. |
| Speed control | ✅ | 0.5×, 1×, 1.5× and 2×. |
| Flow view | ✅ | Blender-inspired nodes, sockets, animated wires and status colours. |
| Table view | ✅ | Row-level transformation view driven by the same playback position. |
| Node inspector | ✅ | Operation details and rows in/out, plus row previews for source, intermediate, branch, group and final nodes. |
| Clause strip | ✅ | Query clauses are clickable and jump playback to the matching stage. |
| Editor synchronization | ✅ | The active SQL clause is highlighted in Monaco during playback. |
| Pan / zoom / fit | ✅ | Drag to pan, scroll to zoom, fit-to-screen and reset controls. |
| SQLite validation | ✅ | Compares simulated final columns, row count and values with SQLite's real result. |
| Truncation reporting | ✅ | Caps are disclosed; real SQLite output is never truncated. |
| Unsupported-query reporting | ✅ | Lists explicit reasons instead of generating a misleading trace. |

## Learning panels

| Capability | Status | Details |
|:---|:---:|:---|
| Learning levels | ✅ | Beginner, Intermediate and Advanced explanations. |
| Stage explanations | ✅ | Concept, why the stage matters, what actually happened with real counts, and the snapshot's detailed explanation. |
| Knowledge checks | ✅ | Multiple-choice checks where available for the active stage. |
| Documentation links | ✅ | Curated SQLite documentation links per stage. |
| Inspector / explanation switch | ✅ | Selecting a node shows its inspector; otherwise the explanation panel follows the active stage. |

## Personalization and settings

| Capability | Status | Details |
|:---|:---:|:---|
| Dark and light themes | ✅ | Theme is persisted in `localStorage`. |
| Workspace preference | ✅ | Query/Canvas choice is persisted in `localStorage`. |
| Reset active database | ✅ | Available from Settings and the editor toolbar. |
| Clear history | ✅ | Confirmation-protected action in Settings. |
| Engine information | ✅ | Displays the SQLite library version reported by the running engine. |
| Sidebar | ✅ | Static on desktop and an overlay drawer below the `md` breakpoint. |

## SQL support for visualization

### Supported

- A single `SELECT` statement with a `FROM` clause.
- Explicit `INNER JOIN`, `LEFT JOIN` and `CROSS JOIN` with `ON` conditions (except `CROSS JOIN`,
  which needs no condition).
- `WHERE` and `HAVING` predicates using `=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `AND`, `OR`, `NOT`,
  `IN`, `BETWEEN`, `IS NULL`, `IS NOT NULL`, `LIKE` and arithmetic (`+`, `-`, `*`, `/`, `%`).
- Column references, table aliases, literals, `*` and `table.*`.
- `GROUP BY` on supported expressions.
- `COUNT`, `SUM`, `AVG`, `MIN` and `MAX` aggregates.
- `DISTINCT`.
- `ORDER BY` on supported expressions.
- `LIMIT` and `OFFSET` with constant numbers.

### Limited

- **Large inputs:** the visual trace is capped at 500 rows and 2,000 events. Source previews show at
  most 12 rows. This affects the animation only, never SQLite's result.
- **Implicit aggregation:** aggregate queries without `GROUP BY` are simulated as a single group, with
  an explicit warning about SQLite's arbitrary-row behavior for bare columns.
- **Order validation:** row order is compared strictly only when `ORDER BY` fully determines it;
  otherwise the comparison is order-insensitive.
- **Group nodes:** the canvas renders up to 8 group nodes, with an explicit overflow node when a
  stage produces more. The underlying trace still contains every group.

### Not visualizable yet

These still run in SQLite and return normal results:

- `INSERT`, `UPDATE`, `DELETE`, DDL, `PRAGMA` and transaction statements.
- Queries without a `FROM` clause (for example `SELECT 1`).
- Common table expressions (`WITH`).
- Compound selects (`UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`).
- Subqueries in any clause.
- Comma-separated cross joins (`FROM a, b`).
- `RIGHT JOIN` and `FULL OUTER JOIN`.
- Window functions and expressions outside the supported grammar, including `CASE`.
- Non-constant `LIMIT` / `OFFSET`.

When a query falls into this list, the app keeps the real SQLite result available and explains why
the visualization is unavailable.

## Known limitations

- **Client-only by design.** There is no account system, cloud sync or server-side database. Data
  lives in the current browser profile.
- **Storage is browser-managed.** Clearing site data removes databases, history and saved queries.
  Private browsing modes may reject IndexedDB writes.
- **Single user.** Concurrent editing from multiple tabs is not coordinated.
- **No sharing or export of traces.** The canvas can be inspected and recorded manually, but there is
  no built-in share link or image/video export.
- **No hosted demo.** Run the project locally with `npm run dev`.
- **Educational model, not a query planner.** The simulator models logical stages only; it does not
  claim to expose SQLite's physical plan, indexes or bytecode.

## Related documentation

- [Architecture](ARCHITECTURE.md) — how execution, simulation, validation and playback fit together.
- [Development guide](DEVELOPMENT.md) — setup, tests and change conventions.
- [README](../README.md) — product overview and screenshots.
