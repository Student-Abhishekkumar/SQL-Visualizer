<h1 align="center">
  <img src="public/favicon.svg" width="72" height="72" alt="SQL Visualizer logo" /><br />
  SQL Visualizer
</h1>

<p align="center">
  <b>See what your SQL actually does.</b><br />
  A browser-based SQL playground that runs real SQLite locally and replays supported
  <code>SELECT</code>, DML and DDL statements as animated, inspectable data-flow or schema graphs.
</p>

<p align="center">
  <img alt="Status: active development" src="https://img.shields.io/badge/status-active_development-F59E0B?style=flat-square" />
  <img alt="1081 unit tests passing" src="https://img.shields.io/badge/unit_tests-1081_passing-2EA043?style=flat-square" />
  <img alt="583 browser QA assertions passing" src="https://img.shields.io/badge/browser_QA-583_passing-2EA043?style=flat-square" />
  <img alt="MIT licensed" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
</p>

<p align="center">
  <a href="#overview">Overview</a> ·
  <a href="#key-features">Features</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#supported-sql-visualization">Supported SQL</a> ·
  <a href="#canvas-features">Canvas</a> ·
  <a href="#database-execution-and-safety">Safety</a> ·
  <a href="#installation-and-setup">Quick start</a> ·
  <a href="#browser-qa">Browser QA</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

<p align="center">
  <a href="#installation-and-setup"><b>Run it locally →</b></a> &nbsp;·&nbsp;
  <a href="docs/ARCHITECTURE.md">Read the architecture</a>
</p>

<p align="center">
  <img src="docs/assets/query-workspace.png" alt="SQL Visualizer query workspace with database explorer, Monaco SQL editor and real SQLite results" width="100%" />
</p>

<p align="center">
  <sub>The Query workspace: database explorer, Monaco editor, saved queries, history and real SQLite results.</sub>
</p>

---

## Overview

SQL Visualizer is a working SQL workspace with an educational execution model layered on top. You
write SQL, run it against a real SQLite database compiled to WebAssembly, and then switch to a
Blender-inspired canvas to watch supported SQL flow through logical stages. DML and DDL previews execute only on an isolated copy, leaving the active database unchanged.

There is no backend, no account and no telemetry. Database files, history and saved queries stay in
the browser's IndexedDB.

| 🎬 Learn by seeing | 🔒 Local by design | ✅ Real results first |
|:---|:---|:---|
| Every stage becomes a node you can step through, with real row counts and inspectable snapshots — including the rows a filter rejects. | SQLite runs as WebAssembly inside the tab. No backend, no account, and no query data leaves your machine. | SQLite executes the query for real. The visual simulator checks its final result against SQLite's output instead of inventing one. |

The visual model is deliberately honest: it is an **educational logical pipeline**, not SQLite's
physical query plan. When a construct cannot be modeled faithfully, the app explains why rather than
guessing.

## Key features

### SQL workspace

| Feature | What it does |
|:---|:---|
| **Real SQLite execution** | Queries execute against SQLite compiled to WebAssembly. Results are not mocked. |
| **Monaco SQL editor** | Syntax highlighting, schema-aware autocomplete and `Ctrl/Cmd + Enter` to run. |
| **Results, messages and query info** | Tabbed output with display types, row counts, execution time, statement breakdown and error messages. |
| **Multiple statements** | Run scripts separated by semicolons; results and messages report per-statement outcomes. |
| **Saved queries and history** | Named queries and an execution log persist across refreshes; history can be filtered by database. |
| **Query / Canvas toggle** | Query is the startup default, including after reload. Both workspaces stay mounted, so editor state, results, zoom, selection and playback survive the switch. `Ctrl/Cmd + Shift + M`. |

### Database workspace

| Feature | What it does |
|:---|:---|
| **Multiple independent databases** | Each database has its own SQLite file and schema; history and saved queries are tagged to it. |
| **Templates and custom SQL** | Start blank, load the University example, or create a database from your own setup script. |
| **Import and export** | Import `.db`, `.sqlite`, `.sqlite3` or `.sql`; export as `.sqlite` or as a SQL script. |
| **Rename, duplicate, reset and delete** | Manage database records without leaving the app. Resetting a template database replays its setup state. |
| **Persistent and local** | Database bytes, metadata, history and saved queries live in IndexedDB. |
| **Schema explorer** | Browse tables, columns, keys and indexes, and open the original `CREATE TABLE` statement. |

### Visualization and inspection

| Feature | What it does |
|:---|:---|
| **Animated logical pipeline** | Renders the supported query pipeline as connected nodes: sources, joins, filters, grouping, projection and the final result. The default animation covers the full pipeline; hover or selection narrows the highlighted upstream path. |
| **Isolated DML and DDL previews** | Visualize supported INSERT/UPDATE/DELETE row changes and CREATE/ALTER/DROP table/index schema changes. Only a temporary clone executes mutations; real rows, `sqlite_master` and PRAGMA metadata feed the same canvas, inspector and playback. |
| **Nested query blocks** | Scalar subqueries, uncorrelated `IN` / `EXISTS` subqueries and non-recursive CTEs run as their own real pipelines, with dependency edges into the stage that consumes them and block-specific playback. Every `UNION` / `UNION ALL` / `INTERSECT` / `EXCEPT` branch is likewise an independent block feeding the actual left-to-right compound operation sequence. |
| **Stage snapshots and playback** | Snapshots carry real rows or real schema metadata through every stage. Play, pause, step, seek, restart or jump to the end, at 0.5×, 1×, 1.5× or 2× speed. |
| **Flow and Table views** | Switch between the node canvas and a row-level table for the current stage, including accepted, filtered, duplicated, grouped or skipped rows. |
| **Branch-aware tracing** | Hover a node to temporarily animate its upstream path; click to pin the selection and open the inspector. Rejected rows branch visibly at filters and `HAVING`. |
| **Floating Node Inspector** | Click a node to open a draggable, resizable window with Overview, Input, Output and Details tabs, real row previews and node-specific information. Collapse it to a header-only strip or minimize it to a dock chip, then restore the same window. |
| **Synchronized explanations** | A documentation sidebar follows the active stage with beginner/intermediate/advanced explanations, real counts, SQLite references and optional knowledge checks. |

## Screenshots

<p align="center">
  <img src="docs/assets/canvas-playback.gif" alt="Animated SQL execution playback: FROM, JOIN, WHERE and SELECT stages flowing through a node canvas" width="700" />
</p>

<p align="center">
  <sub><b>Playback</b> — a real <code>SELECT</code> moving through FROM → JOIN → WHERE → SELECT. Rejected rows branch off at the filter.</sub>
</p>

<table>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/canvas-workspace.png" alt="Animated SQL flow canvas with source tables, join, filter and final result nodes" width="100%" />
      <br />
      <sub><b>Flow canvas</b> — source tables, operations, intermediate results and a final result node.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/table-view.png" alt="Synchronized table view at the WHERE stage showing kept and rejected rows" width="100%" />
      <br />
      <sub><b>Table view</b> — the same playback, focused on row-level transformations.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/database-manager.png" alt="Database manager with independent SQLite databases and import/export actions" width="100%" />
      <br />
      <sub><b>Database manager</b> — create, rename, duplicate, reset, import and export independent databases.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/schema-viewer.png" alt="Schema viewer showing columns, keys, indexes and the CREATE TABLE statement" width="100%" />
      <br />
      <sub><b>Schema viewer</b> — columns, keys and the original DDL for every table.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/node-inspector.png" alt="Floating Node Inspector showing Overview, Input, Output and Details tabs for a canvas node" width="100%" />
      <br />
      <sub><b>Node Inspector</b> — real input and output rows for the selected stage.</sub>
    </td>
    <td width="50%" align="center" valign="top">
      <img src="docs/assets/stage-explanation.png" alt="Documentation sidebar explaining the active SQL stage with counts and SQLite references" width="100%" />
      <br />
      <sub><b>Stage explanations</b> — beginner, intermediate and advanced notes that follow playback.</sub>
    </td>
  </tr>
</table>

## Technology

| Layer | Stack |
|:---|:---|
| **Frontend** | React 19.3 · TypeScript 7.0 · Vite 8.3 · Tailwind CSS 4.3 |
| **SQL engine** | SQLite via sql.js 1.16 (WebAssembly) · node-sql-parser 5.4 · Monaco Editor 0.57 with `@monaco-editor/react` 4.7 |
| **State and persistence** | Zustand 5.1 · idb 8.0 (IndexedDB) |
| **Visualization** | Custom SVG/DOM flow canvas · Motion 14.12 · Lucide React 1.72 |
| **Testing and tooling** | Vitest 5.1 · Testing Library 16.3 · jsdom 31.0 · oxlint 1.90 |

## How it works

```mermaid
flowchart TD
    Q[SQL query] --> SQLITE[(SQLite WASM)]
    SQLITE --> RESULT[Real results, messages, query info]

    Q --> PARSER[SQL parser]
    PARSER --> INTERP[Typed AST interpreter]
    INTERP --> CAP[Capability analyzer]
    CAP --> SIM[Educational logical simulator]
    SIM --> SNAP[Immutable snapshots + event trace]
    SQLITE -. final-result parity .-> SNAP

    SNAP --> GRAPH[Graph builder]
    GRAPH --> FLOW[Flow canvas]
    SNAP --> PLAY[Playback controller]
    PLAY --> FLOW
    PLAY --> TABLE[Table view]
    PLAY --> INSPECT[Node Inspector]
    PLAY --> DOCS[Explanations + knowledge checks]
```

SQLite is always the source of truth. The SELECT simulator applies logical stages to real table data,
records immutable snapshots, and validates its final result against SQLite — ordered when
`ORDER BY` fully determines the order, unordered otherwise. DML previews compare real clone rows;
DDL previews use actual post-statement `sqlite_master` and PRAGMA metadata with row-preservation checks.
If a construct cannot be modeled faithfully, visualization stops with explicit reasons.

## SQL visualization pipeline

| Stage | What it shows |
|:---|:---|
| `FROM` | Source rows read from the live database. |
| `JOIN` | Matched rows from INNER, LEFT and CROSS joins. |
| `WHERE` | Rows accepted or rejected by the filter predicate. |
| `GROUP BY` | Rows collected into groups. |
| `HAVING` | Groups accepted or rejected by the group predicate. |
| `SELECT` | Projected columns and computed values. |
| `DISTINCT` | Duplicate projected rows removed. |
| `COMPOUND` | Independent `SELECT` branches combined left-to-right with `UNION`, `UNION ALL`, `INTERSECT` or `EXCEPT`; distinct set semantics remove duplicates with NULL-safe whole-row comparison. |
| `ORDER BY` | Rows sorted by the requested keys. |
| `LIMIT` / `OFFSET` | Rows kept or skipped at the end of the pipeline. |
| Nested query block | A non-correlated scalar subquery, `IN` / `NOT IN` subquery, `EXISTS` / `NOT EXISTS` subquery, non-recursive CTE, or one `SELECT` branch of a compound query, simulated as its own real pipeline and wired into the stage that consumes it. Compound operations expose their accumulated left input, next right input, retained rows, excluded rows and duplicates. |
| DML preview stages | TARGET, INPUT, COLUMN_MAPPING, INSERT, MATCHED_ROWS, SET, CHANGED_ROWS, UNCHANGED_ROWS, DELETE, RETAINED_ROWS and FINAL_TABLE show actual isolated row changes. |
| DDL schema stages | Catalog, table/column/constraint definitions, ALTER transformation, removed objects and index metadata come from real `sqlite_master` and PRAGMA reads on the isolated copy. |

<details>
<summary><b>Scope and honest limits</b></summary>

- Visualization supports **SELECT** (including compounds), single-table **INSERT/UPDATE/DELETE**, and isolated **CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX and DROP INDEX** previews. ALTER supports table/column rename and add/drop column; indexes include UNIQUE, expression and partial forms. Mutating previews never change the active database or stored snapshot.
- Supported joins: INNER, LEFT and CROSS. Comma cross joins are not supported.
- Supported expressions include comparisons, `AND`/`OR`/`NOT`, `IN`, `BETWEEN`, `IS NULL`, `LIKE`, arithmetic and `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`.
- **Non-correlated scalar subqueries** are supported in `WHERE`, `SELECT` and `JOIN … ON`, following SQLite's rules: an empty result becomes `NULL`, multiple rows use the first row, and the subquery must return one column.
- **Uncorrelated `IN` / `NOT IN` subqueries** are supported with SQLite three-valued logic: an empty result is `false` (`true` for `NOT IN`), a `NULL` outer value is unknown, a `NULL` member makes `NOT IN` unknown, and the subquery must return exactly one column.
- **Uncorrelated `EXISTS` / `NOT EXISTS`** are supported; the subquery's column count is irrelevant and only row presence affects the result.
- **Non-recursive CTEs** (`WITH`) are supported: multiple definitions, chained dependencies, explicit column lists, and supported scalar / `IN` / `EXISTS` subqueries inside a CTE body.
- **`UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT`** compound selects are supported. Each `SELECT` branch is simulated independently, then operators fold strictly left-to-right: `A UNION B INTERSECT C` means `(A UNION B) INTERSECT C`, not `A UNION (B INTERSECT C)`. `UNION` removes duplicates across the accumulated result, `UNION ALL` preserves them until a later distinct operator, `INTERSECT` keeps distinct rows present in both inputs, and `EXCEPT` keeps distinct left rows absent from the right. Comparisons use complete rows with NULL-safe keys, so corresponding NULLs compare equal. Branches must return matching column counts, and the first branch names the output columns. Root `ORDER BY` and `LIMIT` / `OFFSET` apply after the complete chain. Each operation exposes its accumulated left input, next right input, retained rows, excluded rows and duplicates in the canvas, playback and inspector. Table View shows the final compound result and first-branch column names.
- Not yet visualizable: **correlated** subqueries (including correlated `IN` / `EXISTS`), recursive CTEs (`WITH RECURSIVE`), nested compound forms not covered by the existing nested-block interpreter, derived tables in `FROM`, `RIGHT`/`FULL OUTER JOIN`, window functions, `CASE`, and other constructs the parser cannot model conservatively. `INTERSECT ALL`, `EXCEPT ALL`, `UNION DISTINCT` and `INTERSECT DISTINCT` are rejected explicitly rather than approximated.
- The current `node-sql-parser` grammar does not parse every compound form. A quote/comment/parenthesis-aware splitter preserves branch SQL and root clauses as a safe fallback for `INTERSECT`, `EXCEPT` and mixed chains; unsupported or malformed forms return explicit reasons.
- Large inputs are capped for visualization (500 rows, 2,000 events). The real SQLite result remains complete and is never truncated.

See [docs/FEATURES.md](docs/FEATURES.md) for the full capability and limitation matrix.

</details>

## Supported SQL visualization

Everything below runs on real data and is validated against SQLite. Anything outside this surface is
reported with an explicit reason rather than approximated.

### SELECT

- **Filtering and projection:** `WHERE` predicates and `SELECT` lists, including computed expressions.
- **Grouping and aggregation:** `GROUP BY` with `COUNT`, `SUM`, `AVG`, `MIN` and `MAX`, plus `HAVING`.
- **Result shaping:** `DISTINCT`, `ORDER BY` (multiple keys and directions) and `LIMIT` / `OFFSET`.
- **Joins:** INNER, LEFT and CROSS joins, with each input table rendered as its own source node.
- **Names and values:** table/column aliases, `*` wildcards and qualified references, using SQLite's
  own type affinity, `NULL` three-valued logic and collation-aware comparison rules.
- **Honesty:** filters and `HAVING` show the rows they rejected as visible branches, not just counts.

### Advanced queries

- **Scalar subqueries:** non-correlated, in `WHERE`, `SELECT` and `JOIN … ON`; must return one column,
  an empty result becomes `NULL`, and multiple rows use the first row.
- **`IN` / `NOT IN`:** uncorrelated subqueries with SQLite's three-valued logic, including `NULL`
  members and empty results.
- **`EXISTS` / `NOT EXISTS`:** uncorrelated subqueries where only row presence matters.
- **CTEs:** multiple and chained non-recursive `WITH` definitions, explicit column lists, and
  dependency edges drawn between the blocks that consume each other.
- **Compound queries:** `UNION`, `UNION ALL`, `INTERSECT` and `EXCEPT`, including mixed chains
  evaluated strictly left to right, with NULL-safe whole-row duplicate detection.
- **Independent blocks:** every nested block and compound branch is its own pipeline with its own
  snapshots, playback and inspector data.

### DML visualization

- **`INSERT`:** single and multiple `VALUES`, supported `INSERT … SELECT`, and `DEFAULT VALUES`.
- **`UPDATE`:** `WHERE` matching, multiple `SET` assignments, and explicit changed vs. unchanged rows.
- **`DELETE`:** matched, retained and removed rows, including zero-row and no-`WHERE` statements.
- **Isolated preview:** the target table is a source-like node, and the final node shows the
  post-statement table state from the isolated copy — never from your active database.

### DDL visualization

- **`CREATE TABLE`:** explicit columns, constraints, generated columns and `IF NOT EXISTS` no-ops.
- **`ALTER TABLE`:** `RENAME TO`, `RENAME COLUMN`, `ADD COLUMN` and `DROP COLUMN`, with
  row-preservation checks across the change.
- **`DROP TABLE`:** the removed definition, the remaining catalog, dependent index/trigger removal and
  `IF EXISTS` no-ops.
- **Indexes:** `CREATE INDEX` / `CREATE UNIQUE INDEX` (ordinary, expression and partial) and
  `DROP INDEX`, with real PRAGMA metadata and unchanged-row checks.
- **Real catalog data:** schema nodes are built from `sqlite_master` and PRAGMA reads on the isolated
  copy, so the before/after view reflects what SQLite actually reports.

### Worked example: from SQL to canvas

```sql
SELECT d.department_name,
       COUNT(*)      AS employees,
       SUM(e.salary) AS payroll
FROM employees AS e
JOIN departments AS d ON d.id = e.department_id
WHERE e.salary > 30000
GROUP BY d.department_name
HAVING COUNT(*) >= 2
ORDER BY payroll DESC;
```

SQLite returns three rows from the University example:

| department_name | employees | payroll |
|:---|---:|---:|
| Marketing | 3 | 152000 |
| Engineering | 2 | 135000 |
| HR | 2 | 110000 |

Press **Visualize** and the same query unfolds as:

`FROM employees` → `JOIN departments` → `WHERE salary > 30000` → `GROUP BY department_name` → `HAVING COUNT(*) >= 2` → `SELECT` → `ORDER BY payroll DESC`

Each node carries real row counts; filtered rows branch off at the WHERE gate, grouping collects rows
into visible groups, and the final node shows the projected result. Because `ORDER BY` fully
determines the order, the workspace reports **Validated (ordered) vs SQLite**.

## Database execution and safety

There are two separate execution paths, and they never mix:

| Path | What executes | Effect on your data |
|:---|:---|:---|
| **Run** | Your statement batch against the active database | **Writable.** INSERT, UPDATE, DELETE and DDL persist exactly as SQLite applies them. |
| **Visualize** | Supported SELECT reads; DML/DDL run only on an independent database clone | **Never mutates** the active database or its persisted snapshot. |

How the isolated preview works:

- Before a mutating preview, the active database is serialized and loaded into a separate in-memory
  SQLite connection. Every mutation happens on that clone.
- Preview rows, PRAGMA output and `sqlite_master` metadata come from the clone, so the canvas,
  inspector and Table View show what SQLite actually did to it.
- The active database file, the selected database and the IndexedDB snapshot are left untouched.
  The browser QA suite verifies this by comparing full database contents before and after every
  preview, and again after a page reload.
- If a statement cannot be previewed faithfully (for example triggers, generated-column targets or an
  unsupported `ALTER TABLE` form), Visualize refuses with explicit reasons and leaves **no partial
  graph** behind.
- Empty results and no-ops complete honestly: `WHERE 1 = 0`, an `UPDATE` that changes nothing, or
  `CREATE TABLE IF NOT EXISTS` on an existing table are shown as completed operations, not errors.
- Visualize is intentionally scoped. It does not support every valid SQLite statement — unsupported
  statements still run normally through **Run**.

## Database management

Databases are first-class records, not tabs on a single global file:

- **Create** from a blank schema, the University example, or your own setup SQL.
- **Switch** between databases; the active database is remembered across reloads.
- **Rename** metadata or **duplicate** the complete database bytes.
- **Reset** a template database to its setup state, or clear an imported database to empty.
- **Export** as a `.sqlite` file or as a re-creatable SQL script.
- **Import** an existing SQLite file or SQL script as a new database.
- **Inspect** tables, row counts, keys, indexes and original DDL in the schema explorer.

A visualization trace belongs to the database it was built from. Switching databases invalidates the
trace rather than showing data from the wrong workspace.

## Canvas features

The canvas is built from the real trace, not from a fixed template:

- **Trace-driven nodes:** every node corresponds to an operation in this specific trace. Absent stages
  produce no placeholder nodes, and non-applicable clauses never appear.
- **One final result:** the terminal stage feeds the single final node, so there is no duplicate
  terminal data node. It shows the real projected rows, resulting table state or resulting schema.
- **Stable node identity:** a visualization keeps its node ids for its lifetime. Playback, seeking,
  panning, zooming and repeated renders update node *state*, never the graph structure.
- **No stale graphs:** visualizing a different query replaces the graph entirely, and a refused
  visualization clears it instead of leaving a misleading partial graph.
- **Viewport-aware camera:** a new graph opens fully visible when it fits at a readable zoom —
  including side-column branch/group cards and the final node. Very long pipelines open width-fitted
  and top-anchored so labels stay legible. Fit to Screen frames every node, resizing re-fits automatic
  cameras, and manual zoom/pan is never overwritten.
- **Legitimate independent blocks:** nested query blocks and compound branches keep their own nodes
  and playback instead of being merged or duplicated.
- **Animated connections:** sockets and curved wires connect real data dependencies, with animated
  packets on the running stage.
- **Branch-aware tracing:** hovering a node temporarily animates its upstream path; clicking pins the
  selection and opens the inspector.

### Canvas interactions

- **Pan and zoom** by dragging empty canvas space and scrolling; use fit-to-screen and reset controls.
- **Drag nodes** to reposition them; collisions settle locally without changing the query.
- **Hover** a node to animate its branch-aware upstream path without changing the pinned selection.
- **Click** a node to pin that trace and open the floating inspector.
- **Inspect** real input and output rows, group keys, join details, accepted/rejected counts and
  final-result rows. The Overview, Input, Output and Details tabs are node-specific.
- **Read previews at a glance:** nodes show up to four columns and three rows (ten when expanded).
  `+N cols` and tooltips expose hidden columns, full values and the exact row/column counts; empty
  stages say "0 rows after this stage" and an empty final result says "no rows returned".
- **Move and resize** the inspector with its header and eight resize handles. Position and size are
  owned by the workspace, so they survive switching nodes and playback updates.
- **Collapse** the window to its real 52px header strip. The collapsed window has no hidden expanded
  area, drags by its header, and uses the header height for workspace clamping; expanding restores the
  saved width, height and active tab.
- **Minimize** to a dock chip and restore the same window, or close it entirely.
- **Synchronize** with playback: the inspector follows the selected node's current status and never
  reveals final rows before playback produces them.

## Learning and guided exercises

The documentation sidebar is independently toggleable. It keeps its scroll position, learning level
and knowledge-check answer while closed, becomes an edge tab when dismissed, and overlays the canvas
on narrow layouts.

- **Learning levels:** beginner, intermediate and advanced explanations.
- **What happened:** the active stage's explanation uses the real snapshot counts.
- **Knowledge checks:** multiple-choice checks for selected stages at beginner and intermediate levels.
- **References:** curated SQLite documentation links per stage.

**Guided exercises are not implemented yet.** The knowledge checks are the current learning
interaction; a fuller exercise flow remains on the roadmap.

## Installation and setup

**Requirements:** Node.js `^20.19.0` or `>=22.12.0` (required by Vite 8), npm, and a modern browser
with WebAssembly and IndexedDB.

```bash
git clone https://github.com/Student-Abhishekkumar/SQL-Visualizer.git
cd SQL-Visualizer
npm install
npm run dev
```

Open <http://localhost:5173>. The University example database is created on first launch.

## Development commands

| Command | What it does |
|:---|:---|
| `npm install` | Install dependencies. |
| `npm run dev` | Start the Vite development server with HMR. |
| `npm run build` | Type-check and build production assets to `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm test` | Run the full Vitest suite (70 files, 1,065 tests). |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run lint` | Lint the project with oxlint. |
| `npm run typecheck` | Run the TypeScript project build without emitting. |
| `npm run qa:browser` | Drive a real headless Chrome through the Canvas QA suite. |
| `npm run qa:canvas` | Verify viewport-aware layout, fit-to-screen, zoom and resize behavior. |
| `npm run qa:production` | Smoke-test the built bundle without the dev bridge. |

## Verified results

Current state of this repository at this commit:

| Check | Result |
|:---|:---|
| Unit tests | **70 files, 1,081 tests passed** |
| Browser QA | **583/583 assertions passed** (headless Chrome 157) |
| Canvas UX QA | **66/66 assertions passed** (layout, fit, zoom, resize) |
| Lint | **0 warnings, 0 errors** |
| Typecheck | **Passed** |
| Production build | **Passed** |

## Browser QA

The visualization is verified in a real browser, not only in unit tests. `scripts/browser-qa/` drives
headless Chrome over the DevTools Protocol using only Node built-ins, so the project needs **no
Playwright or Cypress dependency**.

```bash
# Full suite: starts its own dev server, writes screenshots and a JSON report,
# and exits non-zero if any assertion fails.
QA_MANAGED_SERVER=1 npm run qa:browser

# Canvas layout/navigation checks: every graph family, fit-to-screen,
# pointer-centred zoom, playback stability and viewport resizing.
QA_MANAGED_SERVER=1 npm run qa:canvas

# Production bundle smoke test (no dev bridge is present in the build).
npm run build
QA_MANAGED_PREVIEW=1 npm run qa:production
```

On Windows PowerShell, set the same variables with `$env:QA_MANAGED_SERVER='1'` before running.

The suite covers five checkpoints:

| Checkpoint | What it verifies |
|:---|:---|
| **A** | App loads, editor accepts typing, database initializes, Run works, Visualize renders, Flow/Table switch, console and network are clean. |
| **B** | Canvas node structure for SELECT, JOIN, nested subqueries, CTEs and compound queries; no placeholder or duplicate nodes; empty results complete honestly. |
| **C** | DML/DDL previews on an isolated clone, with full database-content comparison before/after and after reload; writable Run still mutates the real database. |
| **D** | Zoom, pan, node drag, click-vs-drag threshold, negative-coordinate layout, hover tracing, inspector drag/resize/minimize/restore, and playback/seeking that never changes graph identity. |
| **E** | Visual quality at small/medium/large sizes, title legibility, fit-to-screen containment, playback DOM reuse and timing, repeated-visualization stability. |

Artifacts (screenshots and `report.json`) are written to `artifacts/browser-qa/` and are gitignored.
Chrome or Edge must be installed; set `CHROME_PATH` if it is not in a standard location. Run selected
checkpoints with `QA_ONLY=A,B,C` and target an already-running server with `APP_URL`.

`qa:canvas` covers the Canvas-specific behavior: every graph family opens without horizontal
clipping, Fit to Screen contains every node (including side-column branch/group cards and the final
result), pointer-centred zoom stays anchored, playback never resets manual zoom, and a viewport
resize re-fits automatic cameras without overwriting manual navigation.

## Architecture overview

The app is a single-page React/TypeScript frontend with no server. SQLite runs as WebAssembly inside
the tab, and every layer is separated by typed contracts:

- **Execution:** `services/database/` owns the SQLite connection, multi-database manager, templates and
  IndexedDB persistence.
- **Interpretation:** `services/sql/` parses statements; `services/visualization/` contains the typed
  AST interpreter, capability analyzer, simulator, validators and explanation content.
- **Visualization:** `graphBuilder` turns immutable snapshots into a laid-out flow graph; `flowLayout`,
  `flowGeometry` and `flowPath` handle geometry and routing.
- **UI and state:** `components/` renders the workspace, canvas, inspector and panels; Zustand stores
  in `store/` hold database, editor, history, UI and playback state.
- **Automation:** `scripts/browser-qa/` drives the real browser for regression testing.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full runtime paths and invariants.

### Project structure

```text
src/
├─ app/                   App shell, theme provider, Monaco setup, dev bridge
├─ components/
│  ├─ editor/             Monaco SQL editor, toolbar, example queries
│  ├─ database/           Explorer, manager, schema viewer, database selector
│  ├─ history/            Query history and saved queries
│  ├─ results/            Results table, messages, query information
│  ├─ visualization/      Workspace, flow canvas, playback, table view, inspector, docs sidebar
│  ├─ layout/             Navbar, sidebar, workspace toggle, settings
│  └─ common/             Shared buttons, modal, tabs, tooltip
├─ services/
│  ├─ database/           SQLite WASM engine, multi-database manager, templates, seed data
│  ├─ sql/                Parsing and SQL formatting
│  ├─ visualization/      Interpreter, analyzer, simulator, validation, graph layout, explanations
│  └─ persistence/        IndexedDB persistence and migration
├─ store/                 Zustand stores for database, editor, history, UI and playback
├─ types/                 Shared TypeScript contracts
└─ test/                  Test setup helpers
docs/                     Architecture, feature reference, development guide and assets
public/                   Static assets
```

Only the directories that matter for orientation are shown; component-level tests live next to
their implementation.

## Current limitations

- **Client-only by design.** There is no account system, cloud sync or server-side database. Data
  lives in the current browser profile.
- **Storage is browser-managed.** Clearing site data removes databases, history and saved queries.
  Private browsing modes may reject IndexedDB writes.
- **Single user.** Concurrent editing from multiple tabs is not coordinated.
- **Supported statement scope.** Supported SELECT statements, single-table DML, and the table/index DDL listed above can be visualized. Unsupported DML/DDL forms, transactions and other statements execute normally through Run but report explicit Visualize reasons.
- **Unsupported SELECT constructs.** Correlated subqueries (including correlated `IN` / `EXISTS`),
  recursive CTEs (`WITH RECURSIVE`), nested compound forms not covered by the existing nested-block
  interpreter, derived tables, `RIGHT`/`FULL OUTER JOIN`, `CASE`, window functions and non-constant
  `LIMIT`/`OFFSET` are reported instead of approximated. `INTERSECT ALL`, `EXCEPT ALL`, `UNION DISTINCT`
  and `INTERSECT DISTINCT` are also rejected explicitly.
- **Simulation caps.** Visualization is capped at 500 rows and 2,000 events; source previews show up
  to 12 rows. Real SQLite output is never truncated.
- **Educational model, not a query planner.** The simulator models logical stages only; it does not
  expose SQLite's physical plan, indexes or bytecode.
- **No sharing or capture.** There is no share link, image export or recording export.
- **No hosted demo.** Run the project locally with `npm run dev`.
- **No guided exercises yet.** Knowledge checks and stage explanations are available; full exercises
  are planned.
- **Bundle size.** The main JavaScript chunk is about 7.1 MB (roughly 1.8 MB gzipped), dominated by
  Monaco Editor and sql.js. Vite reports its standard >500 kB chunk warning. No code splitting is
  applied: splitting would not reduce first-load bytes, and lazy-loading Monaco would delay the
  editor.
- **Progressive reveal.** While playback is at the start, operations that have not produced data yet
  can appear as pending cards whose incoming wires arrive as their upstream data does. The completed
  graph is always fully connected.

## Roadmap

The roadmap is directional, not a release commitment.

### ✅ Shipped

- [x] Real SQLite execution in the browser via WebAssembly
- [x] Monaco SQL editor with results, messages and query information
- [x] Multiple independent databases with templates, custom SQL, import/export and IndexedDB persistence
- [x] Animated logical pipeline with stage snapshots, playback and speed control
- [x] Flow and Table views with branch-aware hover and click tracing
- [x] Floating draggable/resizable Node Inspector with header-only collapse and minimize/restore
- [x] Toggleable documentation sidebar with synchronized explanations and knowledge checks
- [x] Non-correlated scalar subqueries simulated as nested pipelines
- [x] Non-recursive CTEs (multiple, chained, explicit columns) with query-block playback and dependency tracing
- [x] Uncorrelated `IN` / `NOT IN` and `EXISTS` / `NOT EXISTS` subqueries with SQLite three-valued logic
- [x] `UNION` / `UNION ALL` compound selects with independent branch pipelines and SQLite parity
- [x] `INTERSECT` / `EXCEPT` and mixed compound chains with left-to-right operation snapshots, canvas tracing, inspector inputs and excluded-row inspection
- [x] Isolated DML previews for `INSERT`, `UPDATE` and `DELETE` with row-level snapshots and zero-change honesty
- [x] Isolated DDL previews for `CREATE`/`ALTER`/`DROP TABLE` and `CREATE`/`DROP INDEX`, with real catalog metadata and no-op handling
- [x] SQLite type affinity, collation and comparison parity for simulated expressions
- [x] Trace-driven Canvas lifecycle: no placeholder stages, no duplicate terminal node, stable node identity during playback
- [x] Real-browser QA automation (583 assertions) covering Canvas structure, interactions and preview safety
- [x] SQLite result-parity validation and conservative unsupported-query reporting

### 🚧 Next up

- [ ] Guided SQL exercises built on the explanation and knowledge-check panels

### 🧭 Planned

- [ ] Recursive CTEs (`WITH RECURSIVE`)
- [ ] General correlated subquery evaluation, scope-aware and SQLite-validated
- [ ] Derived tables in `FROM` / `JOIN`
- [ ] Shareable visualization traces
- [ ] Export a visualization as an image or recording
- [ ] A hosted public demo build

## Documentation

| Document | Contents |
|:---|:---|
| [Architecture](docs/ARCHITECTURE.md) | Runtime paths, simulator guarantees, validation, graph/playback state, inspector geometry and persistence. |
| [Feature reference](docs/FEATURES.md) | Complete feature matrix, supported SQL constructs and known limitations. |
| [Development guide](docs/DEVELOPMENT.md) | Local setup, scripts, test strategy, browser QA, conventions and change checklist. |
| [Browser QA harness](scripts/browser-qa/) | Real-browser regression suite, CDP driver and production smoke test. |
| [Assets](docs/assets/) | Product screenshots and the playback recording. |

## Contributing

Contributions are welcome — especially tests, simulator coverage and accessibility fixes.

1. Fork the repository and create a focused branch.
2. Run `npm install` and `npm test` to confirm the baseline.
3. Make the change; add tests when touching the parser, simulator, validation or playback.
4. Run `npm run lint`, `npm run typecheck` and `npm test`. Changes that affect the Canvas, playback
   or preview safety should also pass `QA_MANAGED_SERVER=1 npm run qa:browser`.
5. Open a pull request describing the change; include a screenshot for UI work.

For larger changes, open an issue first so the approach can be discussed. See the
[development guide](docs/DEVELOPMENT.md) for architecture conventions and a pre-PR checklist.

## License

SQL Visualizer is licensed under the [MIT License](LICENSE).

Copyright © 2026 [Abhishek Kumar](https://github.com/Student-Abhishekkumar).

The MIT License permits use, modification, distribution, and private or commercial use, subject to
its terms. Third-party libraries, assets, fonts and icons remain under their own licenses.

---

<p align="center">
  <sub>Built with SQLite WASM, Monaco, React and a custom flow canvas. The node editor takes visual cues from Blender.</sub><br />
  <sub><a href="#overview">Back to top ↑</a></sub>
</p>
