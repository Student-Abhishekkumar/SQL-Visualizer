# Development guide

SQL Visualizer is a Vite + React + TypeScript application. Everything runs client-side; there is no
server, database service or environment file to configure.

## Requirements

- Node.js `^20.19.0 || >=22.12.0` (required by Vite 8)
- npm (the repository ships a `package-lock.json`)
- A modern browser with WebAssembly and IndexedDB

## Setup

```bash
git clone https://github.com/Student-Abhishekkumar/SQL-Visualizer.git
cd SQL-Visualizer
npm install
npm run dev
```

The dev server runs at <http://localhost:5173>. The University example database is created on first
launch and persisted in IndexedDB.

No environment variables are required. SQLite WASM assets and Monaco are bundled by Vite.

## Scripts

| Command | Purpose |
|:---|:---|
| `npm run dev` | Start the Vite development server with HMR. |
| `npm run build` | Run `tsc -b` and build production assets into `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run lint` | Lint with oxlint. |
| `npm run typecheck` | Run the TypeScript project build without emitting output. |
| `npm run qa:browser` | Drive a real headless Chrome through the Canvas QA suite. |
| `npm run qa:production` | Smoke-test the built bundle (no dev bridge). |

## Testing

The suite covers parser, simulator, graph, component, store and real-SQLite integration behavior. Run `npm test` for the current file/test counts.

- Vitest is configured in `vite.config.ts`.
- Domain, service and store tests run in the default Node environment.
- Component tests opt into jsdom with a per-file `// @vitest-environment jsdom` comment.
- `src/test/setup.ts` loads `@testing-library/jest-dom`.
- Database and persistence tests use `fake-indexeddb` rather than a real browser store.
- Tests live next to the code they cover (`*.test.ts` / `*.test.tsx`).

Run the full suite before opening a pull request:

```bash
npm run lint
npm run typecheck
npm test
```

### Browser QA

`scripts/browser-qa/` drives a real headless Chrome over the DevTools Protocol
using only Node built-ins, so no browser-automation dependency is installed. It
verifies the rendered application rather than the stores: Canvas node structure
for SELECT/nested/CTE/compound/DML/DDL, empty and no-op results, preview
database safety (including a reload to prove persistence is untouched), zoom,
pan, node drag, hover traces, the Node Inspector and playback.

```bash
# Starts its own dev server on 127.0.0.1:5173, writes screenshots and a
# JSON report under artifacts/browser-qa/, and exits non-zero on failure.
QA_MANAGED_SERVER=1 npm run qa:browser

# Production bundle check (no __sqlviz bridge); build first.
npm run build && QA_MANAGED_PREVIEW=1 npm run qa:production
```

Set `QA_ONLY=A,B,C,D,E` to run selected checkpoints and `APP_URL` to target an
already-running server. Chrome or Edge must be installed; set `CHROME_PATH` if
it is not in a standard location.

### What deserves tests

- **Parser and interpreter changes:** supported constructs, aliases, unsupported reasons.
- **Capability analysis:** detected stages, warnings and conservative failure.
- **Simulator:** row roles, ordering, grouping, joins, limits, scalar / `IN` / `EXISTS` subqueries,
  CTEs, `UNION` / `UNION ALL` / `INTERSECT` / `EXCEPT` folding, NULL-safe duplicate handling, stable ids,
  truncation and incomplete propagation.
- **Query blocks:** deterministic block ids, parent/child scope, dependency edges (including CTE reads
  inside nested subqueries), correlation rejection and per-block validation.
- **Validation:** ordered and unordered comparison, column mismatches, floating-point tolerance, all four set operators, and incomplete compound-result suppression.
- **DML and DDL isolation:** success and failure close exactly one clone; active bytes, stored snapshots, selection and connection usability remain unchanged. Run parity/reference checks against independent sql.js databases rather than fabricated schema snapshots.
- **DDL schema traces:** classifier rejection, all five operation groups, real sqlite_master/PRAGMA metadata, constraints and expression indexes, IF EXISTS no-ops, ALTER/index row preservation, cascade-side-effect rejection, graph/inspector/playback and Table View rendering.
- **SQLite value semantics:** declared-type affinity, comparison-time coercion, integer/real literal spelling,
  BINARY and ASCII-only NOCASE comparisons, grouping, `DISTINCT`, aggregates, ordering, CTE/subquery
  metadata propagation and compound operations. Parity suites execute the same SQL against real sql.js;
  unsupported declared collations must fail explicitly rather than fall back to BINARY.
- **Graph layout:** node/edge determinism, branch visibility, subquery sources, compound operation
  sequencing, left-to-right branch wiring and connectivity.
- **Playback:** event folding, per-operation snapshots, seeking, speed and database-switch invalidation.
- **Window geometry:** move, clamp, resize, maximize and header-height collapsed boxes.
- **Components:** user-visible behavior rather than implementation details — including actual
  inspector dimensions, collapse/expand cycles and pointer interactions.

## Architectural rules

These rules keep the educational visualization honest:

1. **SQLite is the source of truth.** Never replace real execution results with simulated ones.
2. **SELECT simulation is read-only.** It reads through the database accessor and never mutates data.
3. **DML and DDL previews are isolated.** Visualization exports active bytes into a separate in-memory sql.js connection, executes there, and always closes it. Never run preview mutations on the active connection or persist its copy; normal Run remains writable. DDL snapshots must come from real sqlite_master/PRAGMA reads and preserve active/stored bytes and selection on success and failure.
4. **No guessed semantics.** If a construct cannot be modeled faithfully, add an unsupported reason
   instead of approximating it silently.
5. **Determinism matters.** The same query and data must produce the same trace, graph and playback.
6. **Row ids are stable.** Never derive identity from an array index that can move.
7. **Seeking is not recomputation.** The trace is immutable; playback only changes the visible event.
8. **Results are not persisted.** History stores SQL text and metadata only.
9. **Workspace state survives switching.** Query and Canvas stay mounted; do not reset editor,
   results, zoom, selection or playback when toggling views.
10. **The inspector's visible box is the interaction box.** Collapsed mode uses the real header
    height for layout, dragging and clamping; the saved expanded geometry is kept separately.
11. **Nested blocks are real inputs.** Evaluate each scalar / `IN` / `EXISTS` / CTE / compound-branch
    block once from live data, reuse its cached value, and propagate truncation and incompleteness
    through real dependency edges. Compound operations fold left-to-right and expose their actual
    accumulated left input, next right input, retained rows, excluded rows and duplicates. Never
    fabricate intermediate rows, and never claim parity for an incomplete trace.

If a change would violate one of these rules, discuss the design before implementing it.

## Adding or changing a visualization stage

A new logical stage touches several layers. Use this checklist:

1. Add the stage to the relevant types in `src/types/visualization.ts`.
2. Teach `src/services/visualization/astInterpreter.ts`, `dmlInterpreter.ts` or `ddlInterpreter.ts` to interpret the construct, or return a clear unsupported reason.
3. Update `src/services/visualization/capabilityAnalyzer.ts` so the stage is detected, ordered and
   described.
4. Implement the transformation and snapshot in `src/services/visualization/simulator.ts`, `dmlSimulator.ts` or `ddlSimulator.ts`, including real row/schema metadata, roles and events.
5. Update `src/services/visualization/graphBuilder.ts` for nodes, edges, sockets and layout.
6. Update `src/services/visualization/clauseMapper.ts` so the clause strip and Monaco highlight stay
   synchronized.
7. Add explanations and learning content in `src/services/visualization/explanations.ts`.
8. Extend `src/services/visualization/nodeInspection.ts` when the stage needs inspector tabs or
   previews.
9. Extend validation coverage if the stage affects the final result or its determinism.
10. Add tests at every layer, then update `docs/FEATURES.md` and `docs/ARCHITECTURE.md`.

The flow canvas renders whatever the graph builder produces; avoid putting query semantics in React
components.

## Persistence changes

IndexedDB schema changes need care because users may already have data:

- Bump the database version in `src/services/persistence/persistenceService.ts`.
- Add the new object store or index inside the upgrade callback.
- Keep old stores long enough to migrate them. The v1 single-database store is intentionally retained
  for this reason.
- Test with `fake-indexeddb`, including the first-run and migration paths.
- Never store result sets; persist only database bytes and the metadata needed to restore the
  workspace.

## Development bridge

In development builds, `window.__sqlviz` exposes a small automation bridge for manual testing and
screenshot tooling. It is tree-shaken out of production builds.

```js
const s = window.__sqlviz

s.databases()                 // database metadata
s.openDatabase(id)            // switch database
s.createDatabase({ name, description, template, setupSql })
s.run('SELECT * FROM employees;')
s.getSchema()
s.setView('canvas')           // 'query' | 'canvas'
s.getPlayback()               // event index, stage, playing, finished, trace database
```

Use it for debugging and repeatable captures; do not make production UI behavior depend on it.

## Manual QA checklist

Before a release or a README asset refresh:

- [ ] Create a blank database, a custom-SQL database and the University example.
- [ ] Run a query with a syntax error and confirm the Messages tab explains it.
- [ ] Run a multi-statement script and check Query Information.
- [ ] Visualize a simple filter, a join, and a grouped query with `HAVING` and `ORDER BY`.
- [ ] Visualize a non-correlated scalar subquery and confirm its nested source appears.
- [ ] Visualize an uncorrelated `IN` / `EXISTS` subquery and a non-recursive CTE; confirm each is its own query block, plays independently and connects to the consuming stage in the canvas.
- [ ] Visualize a `UNION` / `UNION ALL` query; confirm each branch plays independently, both branches feed the first compound operation, and `UNION` duplicates branch off.
- [ ] Visualize an `INTERSECT` and an `EXCEPT` query; confirm distinct operation nodes, real left/right inspector inputs, excluded rows and duplicate rows.
- [ ] Visualize a mixed compound chain and confirm operations and playback run left-to-right, with the final compound result in Table View.
- [ ] Try an unsupported query (for example a correlated subquery, `WITH RECURSIVE`, `INTERSECT ALL`, `EXCEPT ALL` or a nested compound form) and confirm the reasons appear.
- [ ] Confirm the validation badge matches SQLite for each supported query.
- [ ] Visualize INSERT VALUES, INSERT SELECT and DEFAULT VALUES; inspect input mappings, generated ids/defaults and the final table.
- [ ] Visualize UPDATE and DELETE; inspect matched/unmatched, changed/unchanged and deleted/retained rows in Flow and Table View.
- [ ] Confirm DML Visualize leaves active rows, stored snapshots and database selection unchanged, while normal Run still mutates the active database.
- [ ] Visualize CREATE TABLE, each ALTER TABLE action, DROP TABLE, CREATE INDEX and DROP INDEX; inspect real columns, constraints, index keys and before/after catalog states in Flow and Table View.
- [ ] Confirm DDL Visualize leaves active/stored bytes and selection unchanged on success and failure, while normal Run still applies schema changes. Try IF EXISTS / IF NOT EXISTS no-ops, an expression index and a constraint failure.
- [ ] Try unsupported DML (UPSERT, RETURNING, a trigger-backed target or a constraint violation) and confirm no successful trace is shown.
- [ ] Step backward and forward through playback; seek to a stage from the clause strip.
- [ ] Switch Flow/Table and Query/Canvas; confirm state is preserved.
- [ ] Hover and click nodes to check upstream tracing, branch emphasis and inspector opening.
- [ ] Drag, resize, maximize, collapse and minimize the inspector; confirm the collapsed window is
  exactly header-height and that expanding restores the saved geometry and active tab.
- [ ] Toggle the documentation sidebar, answer a knowledge check, close and reopen it, and confirm
  scroll position, learning level and answer are preserved.
- [ ] Rename, duplicate, export, import and reset a database.
- [ ] Reload the page and confirm Query is the startup tab, databases, history and saved queries persist, and an old Canvas selection does not override Query.
- [ ] Drag a node left of the graph origin and confirm it remains positioned there, wires follow it, and canvas panning still works.
- [ ] Toggle light/dark theme and check both themes on the canvas and panels.
- [ ] Check a narrow viewport: the inspector and documentation sidebar become overlays.

## Building and hosting

`npm run build` produces a static `dist/` directory. It can be served by any static host. If the app
is hosted from a subpath, set Vite's `base` option accordingly and verify that the SQLite WASM asset
and favicon resolve. No runtime environment variables are required.

## Documentation assets

Documentation screenshots and the playback recording live in `docs/assets/`. All product images must
come from the running application — no mockups or fabricated UI. Prefer small, meaningful crops and
keep the README gallery focused. When the UI changes, replace affected captures rather than adding
screenshots of retired layouts.

## Pull request checklist

- [ ] The change is focused and explained in the PR description.
- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass.
- [ ] New behavior has tests at the appropriate layer.
- [ ] Unsupported SQL still fails with explicit reasons.
- [ ] Real SQLite results remain authoritative and untruncated.
- [ ] Documentation or screenshots are updated when behavior changes.
- [ ] UI changes include a screenshot in the PR.
