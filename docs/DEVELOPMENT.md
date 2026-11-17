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

## Testing

The suite currently covers 38 files and 600 tests.

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

### What deserves tests

- **Parser and interpreter changes:** supported constructs, aliases, unsupported reasons.
- **Capability analysis:** detected stages, warnings and conservative failure.
- **Simulator:** row roles, ordering, grouping, joins, limits, scalar / `IN` / `EXISTS` subqueries,
  CTEs, stable ids, truncation and incomplete propagation.
- **Query blocks:** deterministic block ids, parent/child scope, dependency edges (including CTE reads
  inside nested subqueries), correlation rejection and per-block validation.
- **Validation:** ordered and unordered comparison, column mismatches, floating-point tolerance.
- **Graph layout:** node/edge determinism, branch visibility, subquery sources and connectivity.
- **Playback:** event folding, seeking, speed and database-switch invalidation.
- **Window geometry:** move, clamp, resize, maximize and header-height collapsed boxes.
- **Components:** user-visible behavior rather than implementation details — including actual
  inspector dimensions, collapse/expand cycles and pointer interactions.

## Architectural rules

These rules keep the educational visualization honest:

1. **SQLite is the source of truth.** Never replace real execution results with simulated ones.
2. **The simulator is read-only.** It reads through the database accessor and never mutates data.
3. **No guessed semantics.** If a construct cannot be modeled faithfully, add an unsupported reason
   instead of approximating it silently.
4. **Determinism matters.** The same query and data must produce the same trace, graph and playback.
5. **Row ids are stable.** Never derive identity from an array index that can move.
6. **Seeking is not recomputation.** The trace is immutable; playback only changes the visible event.
7. **Results are not persisted.** History stores SQL text and metadata only.
8. **Workspace state survives switching.** Query and Canvas stay mounted; do not reset editor,
   results, zoom, selection or playback when toggling views.
9. **The inspector's visible box is the interaction box.** Collapsed mode uses the real header
   height for layout, dragging and clamping; the saved expanded geometry is kept separately.
10. **Nested blocks are real inputs.** Evaluate each scalar / `IN` / `EXISTS` / CTE block once from
    live data, reuse its cached value, and propagate truncation and incompleteness through real
    dependency edges. Never fabricate intermediate rows, and never claim parity for an incomplete
    trace.

If a change would violate one of these rules, discuss the design before implementing it.

## Adding or changing a visualization stage

A new logical stage touches several layers. Use this checklist:

1. Add the stage to the relevant types in `src/types/visualization.ts`.
2. Teach `src/services/visualization/astInterpreter.ts` to interpret the construct, or return a
   clear unsupported reason.
3. Update `src/services/visualization/capabilityAnalyzer.ts` so the stage is detected, ordered and
   described.
4. Implement the transformation and snapshot in `src/services/visualization/simulator.ts`, including
   row roles and events.
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
- [ ] Try an unsupported query (for example a correlated subquery, `WITH RECURSIVE` or `UNION`) and confirm the reasons appear.
- [ ] Confirm the validation badge matches SQLite for each supported query.
- [ ] Step backward and forward through playback; seek to a stage from the clause strip.
- [ ] Switch Flow/Table and Query/Canvas; confirm state is preserved.
- [ ] Hover and click nodes to check upstream tracing, branch emphasis and inspector opening.
- [ ] Drag, resize, maximize, collapse and minimize the inspector; confirm the collapsed window is
  exactly header-height and that expanding restores the saved geometry and active tab.
- [ ] Toggle the documentation sidebar, answer a knowledge check, close and reopen it, and confirm
  scroll position, learning level and answer are preserved.
- [ ] Rename, duplicate, export, import and reset a database.
- [ ] Reload the page and confirm databases, history and saved queries persist.
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
