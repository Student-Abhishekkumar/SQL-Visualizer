# SQL Visualizer

An interactive educational platform for learning SQL by *seeing* how databases process
queries. Stage 1 delivers a professional, fully client-side SQL playground built on a
real SQLite engine running in your browser — no backend, no accounts, no data leaves
your machine.

Stage 2 adds an animated SQL execution visualizer on top of the same real query, with a
logical execution simulator, an animated data-flow canvas, a synchronized table view,
and a playback controller shared across every panel.

The workspace now manages **multiple independent SQLite databases**, and an
always-visible **Query ↔ Canvas** switch keeps both workspaces alive while you move
between writing SQL and watching it run.

![SQL Visualizer — dark workspace](#screenshots)

![SQL Visualizer — dark workspace](#screenshots)

## Screenshots

> Screenshots will be added here. Meanwhile, run the app locally to see the workspace:
> a dark, Linear/Supabase-style layout with a database explorer, Monaco SQL editor and
> tabbed results panel.

## Main features (Stage 1)

- **Multi-database workspace** — create, open, switch, rename, duplicate, reset,
  export and delete independent SQLite databases. Each database is a separate
  `sql.js` instance with its own serialized snapshot, metadata (name, description,
  template, created/modified dates, table/row/byte stats) and history. The active
  database is clearly marked, and the last selected one is restored after a refresh.
- **Database templates** — start **blank**, from the optional **Example** University
  schema, or from **Custom SQL** setup statements (replayed on reset). New databases
  are never seeded unless you pick the example template.
- **Import & export** — import `.db` / `.sqlite` / `.sqlite3` files (validated with a
  SQLite header check and `PRAGMA integrity_check`) or `.sql` scripts. Imports always
  create a new database and never overwrite an existing one. Export a real `.sqlite`
  file or a correctly labelled `.sql` script (`CREATE TABLE`, `INSERT`, indexes, views,
  triggers).
- **Strict database isolation** — switching databases clears stale results,
  visualization traces, schema and selection state, so data from another database can
  never leak into the workspace.
- **Query ↔ Canvas toggle** — a segmented `Code2` / `Workflow` control (plus
  `Ctrl/Cmd+Shift+M`) switches the visible workspace without clearing the editor,
  re-running SQL, resetting playback, or losing node selection, zoom or pan.
- **Real SQL execution** — SQLite compiled to WebAssembly (`sql.js`), executing in a
  Web Worker-free but non-blocking single-page session. `SELECT`, `WHERE`, `ORDER BY`,
  `GROUP BY`, `HAVING`, `DISTINCT`, `LIMIT`, `OFFSET`, `INNER/LEFT/RIGHT/CROSS JOIN`,
  aggregates, subqueries, `CREATE/INSERT/UPDATE/DELETE/DROP`, PRAGMA and multiple
  statements separated by semicolons.
- **Example University Database** — a realistic sample dataset (employees, departments,
  projects, employee_projects) with real primary/foreign key constraints and foreign
  key enforcement, available as a template or created automatically on first launch.
- **Monaco SQL editor** — local (offline) Monaco bundle with SQL syntax highlighting,
  line numbers, bracket matching, schema-aware autocomplete (tables, columns, typed
  from the live database), dark/light themes and `Ctrl+Enter` execution.
- **Professional results panel** — Results / Messages / Query Information tabs,
  sticky-header data grid with row numbers and inferred column types, horizontal
  scrolling, NULL/BLOB formatting, empty-result and no-result-set states.
- **Database explorer** — expandable tables, column types, PK/FK indicators, live row
  counts, indexes and constraints, the original `CREATE TABLE` statement, views and
  triggers, and a per-table schema viewer with sample rows.
- **Query history & saved queries** — every execution recorded with status, duration
  and the database it ran against; filter history to the active database or view all.
  History and saved queries persist in IndexedDB across refreshes.
- **Database reset** — restore the active database to its template state (empty,
  example seed, or custom setup SQL) with an explicit confirmation step.
- **Format SQL / Examples** — a robust keyword-driven SQL formatter (never fails on
  valid input) and a dropdown of 14 executable example queries.
- **Theme toggle, settings, responsive layout** — dark-first design with a light
  palette, draggable editor/results divider, and a mobile drawer sidebar.

## Visualization features (Stage 2)

Press **Visualize** to animate the query in the editor. Nothing is mocked: the
visualizer reads the same live SQLite tables, simulates the logical pipeline
(`FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT`),
and validates its final row count against what SQLite actually returned.

- **Persistent Query/Canvas workspaces** — both views stay mounted, so switching keeps
  the Monaco editor, last results, playback position, selected node, zoom, pan and
  expanded previews exactly as they were. The canvas header shows the active database
  and warns with a **re-visualize** action when the SQL has changed since the trace was
  generated.
- **Flow View (default)** — a query-shaped graph of compact, tactile node modules.
  Source tables (including JOIN inputs) show their real name, alias, row count and a
  live preview; operation nodes show the clause and its condition/expression;
  intermediate results show the rows produced so far; WHERE/HAVING render rejected
  branches; JOINs show inputs converging on two labelled data sockets; GROUP BY fans
  out into real groups; the final result node shows the actual output rows. Every
  operation has its own accent colour (source blue, JOIN purple, WHERE orange, GROUP BY
  teal, HAVING amber, SELECT green, DISTINCT pink, ORDER BY cyan, LIMIT red), used by
  both its header and its outgoing wires. Nodes use circular data/branch sockets and
  smooth curved connections that are re-routed from real socket positions whenever a
  preview grows.
- **Animated data flow** — directional SVG wires with arrowheads, marching dashes and
  moving packets on the connections carrying data right now. Completed, active,
  pending, unsupported and rejected elements are visually distinct; packets are
  representative indicators of the simulator's real movement events, never a claim
  about a specific row, and they stop under `prefers-reduced-motion`.
- **Expandable previews** — table, intermediate-result and rejected-row nodes reveal
  up to ten real rows on demand. Expanding a preview grows the node, pushes nodes
  below it in the same column out of the way, and re-routes the affected wires without
  moving the rest of the pipeline.
- **Shared playback** — play, pause, resume, restart, previous/next event, timeline
  seek and 0.5×/1×/1.5×/2× speed. Flow View and Table View share one controller, so
  switching views preserves the current stage.
- **Synchronized navigation** — click a clause chip, a pipeline stage or a graph node
  to seek to that stage, highlight the matching SQL in the editor, and inspect its
  node. The camera follows the running stage during playback and scrolls sought-to
  stages into view.
- **Table View** — the exact input/output rows of the active stage, with rejected rows
  highlighted and the same playback position as Flow View.
- **Beginner guidance** — a stage explanation panel with Beginner/Intermediate/Advanced
  levels, plain-language hints on nodes, and knowledge checks generated from the real
  execution data.
- **Canvas controls** — drag empty canvas to pan, pointer-centred wheel/trackpad zoom
  (plus toolbar zoom, fit to screen and reset view), expand/collapse real row previews,
  and connected-edge highlighting with unrelated wires dimmed when a node is selected.
  Cursors and toolbar zoom follow the interaction, and the camera only follows playback
  when the running stage leaves the visible band.
- **Accessible & responsive** — nodes are keyboard-operable buttons with ARIA labels,
  motion is disabled under `prefers-reduced-motion`, and a container-query layout keeps
  the canvas usable on narrow screens (the details panel becomes a full-width overlay).

## Technology stack

| Layer         | Technology                                                      |
| ------------- | --------------------------------------------------------------- |
| Frontend      | React 19, TypeScript, Vite 8, Tailwind CSS 4                     |
| Editor        | `@monaco-editor/react` + `monaco-editor` (bundled, no CDN)        |
| Database      | `sql.js` (SQLite → WebAssembly), executed fully client-side       |
| SQL parsing   | `node-sql-parser` (SQLite dialect, non-blocking — parse failures never block execution) |
| State         | Zustand (editor / database / history / UI stores)                 |
| Persistence   | IndexedDB via `idb` (per-database metadata + snapshots, history, saved queries, app state) |
| Animation     | `motion` (UI transitions) + SVG SMIL (data packets)               |
| Icons         | `lucide-react`                                                    |
| Tests         | Vitest, React Testing Library, `fake-indexeddb`                   |

## Installation

Requirements: **Node.js 20+** (tested with Node 26), npm.

```powershell
git clone <your-repo-url> "SQL Visualizer"
cd "SQL Visualizer"
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`).

## Development commands (PowerShell / VS Code)

| Command             | Purpose                                   |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Start the dev server with HMR             |
| `npm run build`     | Type-check (`tsc -b`) + production build  |
| `npm run preview`   | Serve the production build locally        |
| `npm test`          | Run the Vitest suite once                 |
| `npm run test:watch`| Run Vitest in watch mode                  |
| `npm run typecheck` | TypeScript project check only             |
| `npm run lint`      | oxlint                                    |

## Architecture

```
src/
  app/
    App.tsx                     # Root: bootstrap, splash/error states
    providers/ThemeProvider.tsx # Persisted dark/light theme on <html>
    monacoSetup.ts              # Local Monaco, themes, schema autocomplete
    devBridge.ts                # DEV-only automation hook (tree-shaken in prod)
  components/
    layout/    Navbar, Sidebar, MainLayout (split + mounted views),
               WorkspaceViewToggle, SettingsModal
    editor/    SQLEditor (Monaco), EditorToolbar, exampleQueries.ts
    database/  DatabaseExplorer, TableNode, SchemaViewer,
               DatabaseSelector, DatabaseManager, CreateDatabaseForm
    results/   ResultsPanel, ResultsTable, MessagesPanel, QueryInfo
    history/   QueryHistory, SavedQueries
    common/    Button, Tabs, Modal, Tooltip
    visualization/
      VisualizationWorkspace.tsx  # Flow/Table workspace + shared playback UI
      PipelinePanel.tsx            # Stage list (seek)
      TransformationPanel.tsx      # Table View for the active stage
      ExplanationPanel.tsx         # Levels, hints, knowledge checks
      PlaybackControls.tsx         # Play/pause/seek/speed/restart
      RowTable.tsx                 # Shared data grid
      ClauseStrip.tsx              # Clickable SQL clauses → stages
      flow/
        FlowView.tsx               # Derives playback state → canvas props
        FlowCanvas.tsx             # Pan/zoom camera, SVG wires, packets
        FlowNodeView.tsx           # Node modules, sockets, previews
        nodeAccent.ts              # Operation → accent colour identity
        NodeInspector.tsx          # Selected-node details with real rows
  services/
    database/
      databaseManager.ts       # Multi-database lifecycle: create/open/switch/
                               #   rename/duplicate/delete/reset/import/export
      databaseInitializer.ts   # Backwards-compatible lifecycle facade
      templates.ts             # Blank / Example / Custom starter templates
      databaseDump.ts          # Labelled SQL script generation
      sqliteService.ts         # SQLite WASM engine wrapper + batch executor
      schemaService.ts         # Live schema introspection (tables/columns/
                               #   indexes/views/triggers/CREATE SQL)
      seedData.ts              # University schema + seed rows (example template)
      wasmConfig.ts            # Browser WASM asset wiring
    sql/
      sqlParser.ts             # node-sql-parser wrapper (types, tables, errors)
      sqlFormatter.ts          # Keyword-driven SQL pretty-printer
    visualization/
      simulator.ts             # Logical pipeline simulator → trace/snapshots
      validation.ts            # Parity check against real SQLite row counts
      graphBuilder.ts          # Deterministic flow graph + playback state
      flowGeometry.ts          # Socket centres + cubic wire routing
      clauseMapper.ts          # Clause spans for editor highlighting
    persistence/
      persistenceService.ts    # IndexedDB v2: databases/snapshots/app state,
                               #   history + saved queries, legacy migration
  store/
    editorStore.ts             # Editor content (survives view switches)
    databaseStore.ts           # Active DB, metadata list, execution, manager actions
    historyStore.ts            # History + saved queries (database-tagged, persisted)
    uiStore.ts                 # Theme, workspace view, modals, sidebar
    visualizationStore.ts      # Trace + shared playback controller
  types/
    query.ts                   # StatementResult, QueryExecutionResult, History…
    database.ts                # Table/Index/DatabaseSchema, DatabaseInfo…
    visualization.ts           # Trace, events, snapshots, capability
    flowGraph.ts               # Flow graph nodes/edges/bounds contracts
  hooks/
    useSQLExecution.ts         # Editor → engine → history bridge
  utils/
    download.ts                # Browser file downloads for exports
```

### Database architecture

- `sql.js` initializes once. `databaseManager` owns exactly one live
  `SQLiteDatabase` connection at a time plus the metadata list for every known
  database, so a query can only ever target the active database.
- Every database has a persistent `DatabaseInfo` record (`id`, name, description,
  template, timestamps, cached table/row/byte stats) and a serialized snapshot in
  IndexedDB. Mutating executions re-snapshot the active database and refresh its stats.
- Switching opens the target snapshot **before** closing the previous connection, so a
  failed switch leaves the current database usable. A missing or corrupt snapshot is
  rebuilt from that database's template.
- First run creates the optional Example Database (University schema + seed) to
  preserve the original experience. Every other new database stays exactly as created.
- Import validates SQLite files with a header check and `PRAGMA integrity_check`, and
  always creates a new database (unique name suffix) — it never overwrites one.
- History and saved queries are tagged with the database id. Legacy rows from the
  previous single-database version are migrated and tagged automatically.
- `PRAGMA foreign_keys = ON` is applied per connection, so FK constraints are always
  enforced — including in the playground.

### IndexedDB schema (version 2)

| Store       | Key                    | Contents                                   |
| ----------- | ---------------------- | ------------------------------------------ |
| `databases` | `id`                   | `DatabaseInfo` metadata records            |
| `snapshots` | database `id`          | serialized SQLite bytes per database       |
| `app`       | `key`                  | active database id, migration marker       |
| `history`   | `id`                   | execution log (database-tagged)            |
| `queries`   | `id`                   | saved queries (database-tagged)            |
| `database`  | fixed `current`        | legacy v1 snapshot (migrated, left intact) |

The upgrade migrates a v1 `database/current` snapshot into a proper database record
once (guarded by a marker) so existing users keep their data.

### Workspace views

`MainLayout` mounts the Query and Canvas workspaces at the same time and toggles
visibility (`absolute inset-0` + `invisible/opacity-0`). Because nothing unmounts,
switching views cannot clear the editor, re-run SQL, reset playback, change the active
database, or lose node selection/zoom/pan. The choice is persisted in `localStorage`.

### SQL execution architecture

`execute(sql)` in `databaseStore`:

1. Rejects empty/comment-only input with a friendly message (never fakes a run).
2. Splits the batch on top-level semicolons (quote/comment aware).
3. Executes each statement via `prepare/step` (so zero-row queries still expose
   column headers) and records per-statement type, rows, `rowsModified`, and duration.
4. Stops at the first SQLite error, surfacing the statement index and the real error
   text in the Messages tab.
5. Persists a snapshot and refreshes the explorer after mutating statements.
6. Returns a normalized `QueryExecutionResult` — also mirrored as flat
   `columns/rows/rowCount` for the primary result set.

Statements that return no result set are clearly distinguished from empty result sets;
returned-row counts are never conflated with modified-row counts.

## Visualization engine (Stage 2)

SQLite does not expose intermediate execution states, so the visualizer runs a
separate **logical simulator** (`services/visualization/simulator.ts`) over the same
real table data:

1. `node-sql-parser` extracts the query structure (tables, joins, predicates, groups,
   projections, ordering, limits) in `astInterpreter`.
2. The simulator applies the logical pipeline to the actual rows, emitting immutable
   per-stage snapshots (rows, removed rows, roles, groups, columns, explanations) and a
   chronologically ordered event trace — intro → per-stage row events → stage
   completion → final.
3. `validation.ts` compares the simulated final row count with the row count SQLite
   actually returned and reports any mismatch instead of hiding it.
4. `graphBuilder.ts` turns the trace into a deterministic, query-shaped graph
   (positions, edges, branch columns, labels, bounds) with no external graph
   dependency, and derives the playback state (hidden/pending/active/completed) for any
   timeline position.

The simulator never mutates the database, never fabricates rows, and never special-cases
the sample schema — row identities stay stable across stages and truncation is always
reported.

## Current limitations

- **Animated packets are representative, not per-row.** A packet shows that data is
  flowing along a real dependency; it is not a specific record.
- **Previews are capped** (3 rows collapsed / 10 expanded, 12 per source table) and
  group fan-out is capped at 8 group nodes plus an “and more” node, so the canvas stays
  bounded. Caps are reported, never silently applied to results.
- **SVG `animateMotion` packets require a Chromium-based browser**; other engines show
  the edges, arrowheads and marching overlay without moving packets.
- **The flow layout is deterministic, not auto-directed.** Graphs are laid out
  top-to-bottom with a side column for branches/groups; very wide combined queries may
  need a pan to reach the branch column (the legend, zoom and fit controls help).
- SQLite runs on the main thread; very large result sets could briefly block the UI
  (the service is structured so a Web Worker host can be added without UI changes).
- Only one database connection is live at a time; others live as snapshots in
  IndexedDB, so very large numbers of databases increase storage and switch latency.
- Imports must fit in browser memory, and `.sql` imports are executed as written —
  an unsupported script fails with the SQLite error rather than being partially
  imported.
- Monaco's bundle makes the main JS chunk large (expected for a local Monaco setup).
- Foreign keys are enforced but `ON DELETE`/`ON UPDATE` actions beyond the schema's
  defaults are not surfaced in the explorer UI.
- The SQL formatter is keyword-driven — it never fails, but does not reflow every
  possible nesting style.
- No E2E (Playwright) tests yet; testing is unit/integration (Vitest + RTL),
  including real SQLite-in-Node integration tests, multi-database creation/isolation/
  import/export scenario tests, IndexedDB persistence/migration tests and canvas
  interaction/reduced-motion tests.

## Roadmap

- Explicit execution-plan ordering hints (`EXPLAIN QUERY PLAN`) next to the logical
  pipeline.
- Guided lessons that chain several queries around one concept.
- Auto-arranged edge routing for extremely wide nested queries.
- Optional Web Worker host for SQLite and simulation.

## License

MIT — built for learning.
