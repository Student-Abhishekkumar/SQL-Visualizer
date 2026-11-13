# SQL Visualizer

An interactive educational platform for learning SQL by *seeing* how databases process
queries. Stage 1 delivers a professional, fully client-side SQL playground built on a
real SQLite engine running in your browser — no backend, no accounts, no data leaves
your machine.

Stage 2 will add the animated SQL execution visualizer on top of the integration
points prepared in this stage.

![SQL Visualizer — dark workspace](#screenshots)

## Screenshots

> Screenshots will be added here. Meanwhile, run the app locally to see the workspace:
> a dark, Linear/Supabase-style layout with a database explorer, Monaco SQL editor and
> tabbed results panel.

## Main features (Stage 1)

- **Real SQL execution** — SQLite compiled to WebAssembly (`sql.js`), executing in a
  Web Worker-free but non-blocking single-page session. `SELECT`, `WHERE`, `ORDER BY`,
  `GROUP BY`, `HAVING`, `DISTINCT`, `LIMIT`, `OFFSET`, `INNER/LEFT/RIGHT/CROSS JOIN`,
  aggregates, subqueries, `CREATE/INSERT/UPDATE/DELETE/DROP`, PRAGMA and multiple
  statements separated by semicolons.
- **University Database** — a realistic sample dataset (employees, departments,
  projects, employee_projects) with real primary/foreign key constraints and foreign
  key enforcement, seeded automatically on first launch.
- **Monaco SQL editor** — local (offline) Monaco bundle with SQL syntax highlighting,
  line numbers, bracket matching, schema-aware autocomplete (tables, columns, typed
  from the live database), dark/light themes and `Ctrl+Enter` execution.
- **Professional results panel** — Results / Messages / Query Information tabs,
  sticky-header data grid with row numbers and inferred column types, horizontal
  scrolling, NULL/BLOB formatting, empty-result and no-result-set states.
- **Database explorer** — expandable tables, column types, PK/FK indicators, live row
  counts, a per-table schema viewer with sample rows, and schema refresh after DDL.
- **Query history & saved queries** — every execution recorded with status, duration
  and row count; history and saved queries persist in IndexedDB across refreshes.
- **Database reset** — one click restores the original seed data.
- **Format SQL / Examples** — a robust keyword-driven SQL formatter (never fails on
  valid input) and a dropdown of 14 executable example queries.
- **Theme toggle, settings, responsive layout** — dark-first design with a light
  palette, draggable editor/results divider, and a mobile drawer sidebar.

## Technology stack

| Layer         | Technology                                                      |
| ------------- | --------------------------------------------------------------- |
| Frontend      | React 19, TypeScript, Vite 8, Tailwind CSS 4                     |
| Editor        | `@monaco-editor/react` + `monaco-editor` (bundled, no CDN)        |
| Database      | `sql.js` (SQLite → WebAssembly), executed fully client-side       |
| SQL parsing   | `node-sql-parser` (SQLite dialect, non-blocking — parse failures never block execution) |
| State         | Zustand (editor / database / history / UI stores)                 |
| Persistence   | IndexedDB via `idb` (database snapshot, history, saved queries)   |
| Animation     | `motion` (installed; used by Stage 2 visualizations)              |
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
    layout/    Navbar, Sidebar, MainLayout (draggable split), SettingsModal
    editor/    SQLEditor (Monaco), EditorToolbar, exampleQueries.ts
    database/  DatabaseExplorer, TableNode, SchemaViewer
    results/   ResultsPanel, ResultsTable, MessagesPanel, QueryInfo
    history/   QueryHistory, SavedQueries
    common/    Button, Tabs, Modal, Tooltip
  services/
    database/
      sqliteService.ts         # SQLite WASM engine wrapper + batch executor
      databaseInitializer.ts   # Lifecycle: restore-or-seed, reset, live handle
      schemaService.ts         # Live schema introspection (PRAGMA-based)
      seedData.ts              # University Database schema + seed rows
      wasmConfig.ts            # Browser WASM asset wiring
    sql/
      sqlParser.ts             # node-sql-parser wrapper (types, tables, errors)
      sqlFormatter.ts          # Keyword-driven SQL pretty-printer
    persistence/
      persistenceService.ts    # IndexedDB stores (snapshot/history/queries)
  store/
    editorStore.ts             # Editor content (survives tab switches)
    databaseStore.ts           # Status, schema, execution orchestration
    historyStore.ts            # History + saved queries (persisted)
    uiStore.ts                 # Theme, modals, sidebar
  types/
    query.ts                   # StatementResult, QueryExecutionResult, History…
    database.ts                # TableSchema, ColumnSchema, DatabaseStatus…
    visualization.ts           # Stage 2 contracts (VisualizationTrace…)
  hooks/
    useSQLExecution.ts         # Editor → engine → history bridge
```

### Database architecture

- `sql.js` initializes once; the live `SQLiteDatabase` handle is a module singleton so
  consecutive queries run against the same session.
- First launch runs the schema + seed DDL/DML and writes a serialized snapshot to
  IndexedDB. Every mutating execution re-snapshots the database.
- On reload the snapshot is restored (corrupt snapshots fall back to a fresh seed).
- `PRAGMA foreign_keys = ON` is applied per connection, so FK constraints are always
  enforced — including in the playground.

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

## Stage 2 readiness

The visualization contracts live in `src/types/visualization.ts`
(`VisualizationEvent`, `VisualizationTrace`, `VisualizationEngine`) and
`QueryExecutionResult.visualization` is reserved for the trace. SQLite does **not**
expose intermediate execution states — Stage 2 will implement a separate logical
query simulator that produces genuine educational traces through these interfaces,
independent of the SQLite execution path. Stage 1 generates no fake events.

## Current limitations (Stage 1)

- SQLite runs on the main thread; very large result sets could briefly block the UI
  (the service is structured so a Web Worker host can be added without UI changes).
- Monaco's bundle makes the main JS chunk large (expected for a local Monaco setup).
- Foreign keys are enforced but `ON DELETE`/`ON UPDATE` actions beyond the schema's
  defaults are not surfaced in the explorer UI.
- The SQL formatter is keyword-driven — it never fails, but does not reflow every
  possible nesting style.
- No E2E (Playwright) tests yet; testing is unit/integration (Vitest + RTL),
  including real SQLite-in-Node integration tests and IndexedDB-backed persistence
  tests.

## Roadmap (Stage 2)

- Animated query execution: scan → filter → join → group → sort → limit → project.
- Table data visualization panels and JOIN animation.
- Execution-plan style step breakdown and interactive lessons.

## License

MIT — built for learning.
