/**
 * Browser QA suite for SQL Visualizer (Stage 8G).
 *
 * Drives a real headless Chrome through the DevTools Protocol with no added
 * dependency. Expects a dev server (default http://127.0.0.1:5173/) unless
 * QA_MANAGED_SERVER=1, in which case it starts and stops one itself.
 *
 * Checkpoints:
 *   A  app smoke test
 *   B  SELECT / nested / CTE / compound Canvas structure
 *   C  DML / DDL visualization and database preview safety
 *   D  Canvas interactions, inspector and playback
 *   E  visual quality, performance and final regression sweep
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9335)
const requested = (process.env.QA_ONLY ?? 'A,B,C,D,E').split(',').map((entry) => entry.trim().toUpperCase())
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', `run-${stamp}`)

const results = []
const artifacts = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function check(group, name, ok, detail = '') {
  const record = { group, name, ok: Boolean(ok), detail }
  results.push(record)
  const marker = ok ? 'PASS' : 'FAIL'
  console.log(`${marker} [${group}] ${name}${detail ? ` — ${detail}` : ''}`)
  return Boolean(ok)
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

/** Start a Vite dev server when the suite must be self-contained. */
async function startServer() {
  const child = spawn(
    process.execPath,
    [join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    { stdio: 'ignore', windowsHide: true },
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dev server exited with code ${child.exitCode}`)
    try {
      const response = await fetch(APP_URL)
      if (response.ok) return child
    } catch {
      /* not listening yet */
    }
    await sleep(200)
  }
  throw new Error('Dev server did not start within 60s')
}

async function stopServer(child) {
  if (!child) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function preparePage(page) {
  await page.waitFor(`Boolean(window.__sqlviz)`, { label: 'dev bridge', timeout: 60_000 })
  await page.waitFor(`window.__sqlviz.databases().length > 0`, { label: 'database initialized', timeout: 60_000 })
  await page.waitFor(`Boolean(window.__sqlviz.getTrace().sessionId !== undefined)`, { label: 'trace summary available' })
  await sleep(300)
  // Elapsed since navigation start: how long a user waits for a usable app.
  return page.evaluate(`Math.round(performance.now())`)
}

/** Visualize a query through the real toolbar button. */
async function visualize(page, sql) {
  await page.evaluate(`window.__sqlviz.setView('query')`)
  await sleep(150)
  const before = await page.evaluate(`window.__sqlviz.getTrace().sessionId`)
  await page.evaluate(`window.__sqlviz.setEditor(${JSON.stringify(sql)})`)
  await sleep(150)
  await page.clickByText('Visualize')
  await page.waitFor(`window.__sqlviz.getTrace().sessionId > ${before}`, { label: 'new visualization session' })
  await page.waitFor(`window.__sqlviz.getView() === 'canvas'`, { label: 'canvas view active' })
  await page.waitFor(`document.querySelectorAll('[data-node-id]').length > 0 || window.__sqlviz.getTrace().trace === null`, {
    label: 'canvas rendered',
  })
  await sleep(200)
  return page.evaluate(`window.__sqlviz.getTrace()`)
}

/** Visualize and require a successful trace. */
async function visualizeOk(page, sql) {
  const state = await visualize(page, sql)
  if (state.trace === null) {
    throw new Error(`Visualization failed for "${sql}": ${(state.unavailableReasons ?? []).join('; ')}`)
  }
  return state
}

async function canvasSnapshot(page) {
  return page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-node-id]')].map((element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        id: element.getAttribute('data-node-id'),
        kind: element.getAttribute('data-kind'),
        stage: element.getAttribute('data-stage'),
        status: element.getAttribute('data-status'),
        accent: element.getAttribute('data-accent'),
        selected: element.getAttribute('data-selected') === 'true',
        upstream: element.getAttribute('data-upstream') === 'true',
        dragging: element.getAttribute('data-dragging') === 'true',
        label: (element.querySelector('.flow-node-title')?.textContent ?? '').trim(),
        detail: (element.querySelector('.flow-node-subtitle')?.textContent ?? '').trim(),
        visible: rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      }
    })
    const edges = [...document.querySelectorAll('.flow-edge')].map((element) => ({
      id: element.getAttribute('data-edge-id'),
      from: element.getAttribute('data-from'),
      to: element.getAttribute('data-to'),
      kind: element.getAttribute('data-kind'),
      status: element.getAttribute('data-status'),
    }))
    const app = document.querySelector('[role="application"]')
    return {
      nodes,
      edges,
      hoveredNode: app?.getAttribute('data-hovered-node') ?? null,
      selectedNode: app?.getAttribute('data-selected-node') ?? null,
      traceMode: app?.getAttribute('data-trace-mode') ?? null,
    }
  })()`)
}

/** Operation stages in vertical pipeline order. */
function operationStages(snapshot) {
  return snapshot.nodes
    .filter((node) => node.kind === 'operation')
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .map((node) => node.stage)
}

/** Click the playback control that jumps to the last event. */
async function jumpToFinal(page) {
  await page.click('[aria-label="Jump to final result"]')
  await page.waitFor(`window.__sqlviz.getPlayback().finished === true`, { label: 'playback finished' })
  await sleep(150)
}

function overlaps(snapshot, tolerance = 2) {
  const visible = snapshot.nodes.filter((node) => node.visible)
  const pairs = []
  for (let i = 0; i < visible.length; i += 1) {
    for (let j = i + 1; j < visible.length; j += 1) {
      const a = visible[i]
      const b = visible[j]
      const dx = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.x, b.rect.x)
      const dy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.y, b.rect.y)
      if (dx > tolerance && dy > tolerance) pairs.push(`${a.id} × ${b.id} (${Math.round(dx)}×${Math.round(dy)}px)`)
    }
  }
  return pairs
}

/** Structural invariants that must hold for every rendered graph. */
function graphInvariants(group, name, state, snapshot) {
  const trace = state.trace
  const ids = snapshot.nodes.map((node) => node.id)
  const uniqueIds = new Set(ids)
  check(group, `${name}: node ids are unique`, uniqueIds.size === ids.length, `${ids.length} nodes, ${uniqueIds.size} unique`)

  const finals = snapshot.nodes.filter((node) => node.kind === 'final')
  check(group, `${name}: exactly one final result node`, finals.length === 1, `${finals.length} final nodes`)

  const knownStages = new Set([
    ...trace.stages,
    ...(trace.nested ?? []).flatMap((block) => block.stages),
  ])
  const strayStages = snapshot.nodes.filter(
    (node) => node.kind === 'operation' && node.stage !== null && node.stage !== undefined && !knownStages.has(node.stage),
  )
  check(
    group,
    `${name}: no placeholder operation nodes`,
    strayStages.length === 0,
    strayStages.map((node) => `${node.id}:${node.stage}`).join(', '),
  )

  const terminalStage = trace.stages[trace.stages.length - 1]
  check(
    group,
    `${name}: no duplicate terminal data node`,
    !ids.includes(`data-${terminalStage}`),
    `terminal stage ${terminalStage}`,
  )

  const nodeIds = new Set(ids)
  const danglingEdges = snapshot.edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to))
  check(group, `${name}: every edge connects rendered nodes`, danglingEdges.length === 0, `${danglingEdges.length} dangling`)

  const connected = new Set()
  for (const edge of snapshot.edges) {
    connected.add(edge.from)
    connected.add(edge.to)
  }
  const isolated = snapshot.nodes.filter((node) => node.visible && !connected.has(node.id))
  check(group, `${name}: no disconnected nodes`, isolated.length === 0, isolated.map((node) => node.id).join(', '))

  const overlapping = overlaps(snapshot)
  check(group, `${name}: no overlapping nodes`, overlapping.length === 0, overlapping.slice(0, 4).join('; '))

  check(
    group,
    `${name}: final result node is visible`,
    finals.some((node) => node.visible),
    finals.map((node) => `${node.id}@${Math.round(node.rect.y)}`).join(', '),
  )
}

// ---------------------------------------------------------------------------
// Checkpoint A — smoke
// ---------------------------------------------------------------------------

async function checkpointA(page, report) {
  section('Checkpoint A — application smoke test')

  const basics = await page.evaluate(`(() => ({
    title: document.title,
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    splashPresent: Boolean(document.getElementById('boot-splash')),
    bodyLength: (document.body.innerText ?? '').length,
    bridge: Boolean(window.__sqlviz),
    view: window.__sqlviz.getView(),
    databases: window.__sqlviz.databases().map((database) => ({ name: database.name, template: database.template })),
    activeId: window.__sqlviz.getActiveDatabaseId(),
  }))()`)
  check('A', 'application renders (no blank screen)', basics.rootChildren > 0 && basics.bodyLength > 100, `root children ${basics.rootChildren}`)
  check('A', 'boot splash removed after hydration', basics.splashPresent === false)
  check('A', 'document title is correct', basics.title === 'SQL Visualizer', basics.title)
  check('A', 'dev bridge installed', basics.bridge === true)
  check('A', 'starter database exists and is active', basics.databases.length > 0 && basics.activeId !== null, JSON.stringify(basics.databases))

  const schema = await page.evaluate(`window.__sqlviz.getSchema()`)
  const tableNames = (schema?.tables ?? []).map((table) => table.name)
  check('A', 'schema explorer lists seeded tables', ['departments', 'employees', 'projects', 'employee_projects'].every((name) => tableNames.includes(name)), tableNames.join(', '))

  const sidebarText = await page.evaluate(`document.querySelector('aside')?.innerText ?? ''`)
  check('A', 'sidebar renders table names', ['employees', 'departments', 'projects'].every((name) => sidebarText.includes(name)))

  // Editor accepts real keyboard input (not just store injection).
  // Monaco is lazy-loaded behind Suspense. Wait for the real editor rather
  // than assuming the database-ready state also means its chunk has loaded.
  await page.evaluate(`window.__sqlviz.setView('query')`)
  await page.waitFor(
    `(() => {
      const editor = document.querySelector('.monaco-editor .view-lines, textarea.ime-text-area, textarea.inputarea')
      if (editor === null) return false
      const rect = editor.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })()`,
    { label: 'Monaco editor ready', timeout: 60_000 },
  )
  const editor = (await page.rect('.monaco-editor .view-lines')) ?? (await page.rect('textarea.ime-text-area')) ?? (await page.rect('textarea.inputarea'))
  if (editor !== null) {
    await page.evaluate(`window.__sqlviz.setEditor('')`)
    await page.clickAt(editor.x, editor.y)
    await page.insertText('SELECT 42')
    await sleep(300)
    const typed = await page.evaluate(`window.__sqlviz.getEditor()`)
    check('A', 'editor accepts typed input', typed.includes('SELECT 42'), JSON.stringify(typed.slice(0, 60)))
  } else {
    check('A', 'editor accepts typed input', false, 'Monaco editor view not found')
  }

  // Normal Run path executes SQL.
  await page.evaluate(`window.__sqlviz.setEditor('SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 3')`)
  await page.evaluate(`window.__sqlviz.setView('query')`)
  await sleep(150)
  await page.clickByText('Run')
  await page.waitFor(`document.querySelectorAll('table tbody tr').length > 0`, { label: 'run results', timeout: 20_000 })
  const runRows = await page.evaluate(`document.querySelectorAll('table tbody tr').length`)
  check('A', 'Run executes SQL and shows rows', runRows >= 3, `${runRows} rows`)

  const consoleErrors = report.consoleErrors
  check('A', 'no console errors on load and Run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  check('A', 'no uncaught page exceptions', report.pageErrors.length === 0, report.pageErrors.slice(0, 2).join(' | '))
  check('A', 'no failed requests', report.failedRequests.length === 0, report.failedRequests.slice(0, 3).join(' | '))
  check('A', 'no 4xx/5xx responses', report.badResponses.length === 0, report.badResponses.slice(0, 3).join(' | '))

  // Visualize produces a graph.
  const state = await visualizeOk(page, 'SELECT * FROM employees;')
  check('A', 'Visualize produces a Canvas graph', state.trace !== null)
  const snapshot = await canvasSnapshot(page)
  check('A', 'Canvas renders nodes', snapshot.nodes.length > 0, `${snapshot.nodes.length} nodes`)
  check('A', 'Canvas renders edges', snapshot.edges.length > 0, `${snapshot.edges.length} edges`)

  // Flow <-> Table view switch inside the visualization workspace.
  await page.clickByText('Table')
  await page.waitFor(`document.querySelectorAll('[data-node-id]').length === 0 || !document.querySelector('[role="application"]')?.offsetParent`, {
    label: 'table view active',
  })
  const tableView = await page.evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((entry) => (entry.textContent ?? '').trim().toLowerCase().startsWith('table'))
    return { selected: tab?.getAttribute('aria-selected') === 'true' }
  })()`)
  check('A', 'Table view tab activates', tableView.selected === true)
  await page.clickByText('Flow')
  await page.waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, { label: 'flow view restored' })
  check('A', 'Flow view restores the Canvas', (await canvasSnapshot(page)).nodes.length > 0)

  report.artifacts.push(await page.screenshot('A-smoke-canvas.png'))
}

// ---------------------------------------------------------------------------
// Checkpoint B — SELECT, nested, CTE, compound
// ---------------------------------------------------------------------------

const SELECT_CASES = [
  { name: 'SELECT *', sql: 'SELECT * FROM employees;', ops: ['SELECT'] },
  { name: 'WHERE', sql: 'SELECT name FROM employees WHERE department_id = 2;', ops: ['WHERE', 'SELECT'] },
  { name: 'GROUP BY', sql: 'SELECT department_id, COUNT(*) FROM employees GROUP BY department_id;', ops: ['GROUP_BY', 'SELECT'] },
  { name: 'ORDER BY + LIMIT', sql: 'SELECT name FROM employees ORDER BY name LIMIT 5;', ops: ['SELECT', 'ORDER_BY', 'LIMIT'] },
  {
    name: 'DISTINCT',
    sql: 'SELECT DISTINCT city FROM employees ORDER BY city;',
    ops: ['SELECT', 'DISTINCT', 'ORDER_BY'],
  },
  {
    name: 'HAVING',
    sql: 'SELECT department_id, COUNT(*) FROM employees GROUP BY department_id HAVING COUNT(*) > 1;',
    ops: ['GROUP_BY', 'HAVING', 'SELECT'],
  },
  {
    name: 'JOIN',
    sql: 'SELECT e.name, d.department_name FROM employees e JOIN departments d ON d.id = e.department_id;',
    ops: ['JOIN', 'SELECT'],
  },
]

async function checkpointB(page, report) {
  section('Checkpoint B — SELECT, nested, CTE and compound Canvas')

  for (const testCase of SELECT_CASES) {
    const state = await visualizeOk(page, testCase.sql)
    const initial = await canvasSnapshot(page)
    // Progressive reveal: before playback runs, no stage has produced data,
    // so only the always-available source node carries rows.
    check(
      'B',
      `${testCase.name}: no stage data revealed before playback`,
      initial.nodes.filter((node) => node.visible && (node.kind === 'data')).length === 0,
      initial.nodes.filter((node) => node.visible && node.kind === 'data').map((node) => node.id).join(', '),
    )
    await jumpToFinal(page)
    const snapshot = await canvasSnapshot(page)
    const ops = operationStages(snapshot).filter((stage) => stage !== 'TARGET')
    check('B', `${testCase.name}: operation nodes match the trace`, JSON.stringify(ops) === JSON.stringify(testCase.ops), `rendered ${JSON.stringify(ops)} expected ${JSON.stringify(testCase.ops)}`)
    check('B', `${testCase.name}: visualization validated against SQLite`, state.trace && state.validation?.validated === true, JSON.stringify(state.validation?.validated))
    graphInvariants('B', testCase.name, state, snapshot)
    const finalNode = snapshot.nodes.find((node) => node.kind === 'final')
    check('B', `${testCase.name}: final node shows the real result`, finalNode !== undefined && finalNode.label.length > 0, `${finalNode?.label} / ${finalNode?.detail}`)
    report.artifacts.push(await page.screenshot(`B-${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`))
  }

  const nestedCases = [
    {
      name: 'scalar subquery',
      sql: 'SELECT name, salary FROM employees WHERE salary > (SELECT AVG(salary) FROM employees);',
    },
    {
      name: 'IN subquery',
      sql: 'SELECT name FROM employees WHERE department_id IN (SELECT id FROM departments WHERE location = \'New York\');',
    },
    {
      // Correlation is a documented limitation; this EXISTS is independent.
      name: 'EXISTS subquery',
      sql: 'SELECT name FROM employees WHERE EXISTS (SELECT 1 FROM employee_projects WHERE project_id = 1);',
    },
    {
      name: 'multiple CTEs',
      sql: `WITH high AS (SELECT id, name, salary FROM employees WHERE salary > 60000),
      dept AS (SELECT id, department_name FROM departments)
      SELECT h.name, d.department_name FROM high h JOIN dept d ON d.id = 1;`,
    },
    {
      name: 'CTE chain',
      sql: `WITH base AS (SELECT id, salary FROM employees),
      doubled AS (SELECT id, salary * 2 AS doubled FROM base)
      SELECT id, doubled FROM doubled ORDER BY id;`,
    },
  ]

  for (const testCase of nestedCases) {
    const state = await visualizeOk(page, testCase.sql)
    await jumpToFinal(page)
    const snapshot = await canvasSnapshot(page)
    const blocks = state.trace.nested ?? []
    check('B', `${testCase.name}: trace records nested blocks`, blocks.length > 0, blocks.map((block) => `${block.id}:${block.kind}`).join(', '))
    for (const block of blocks) {
      const blockNodes = snapshot.nodes.filter((node) => node.id.startsWith(`${block.id}-`))
      check('B', `${testCase.name}: block ${block.id} has its own nodes`, blockNodes.length > 0, `${blockNodes.length} nodes`)
      const missing = block.stages.filter(
        (stage) => !snapshot.nodes.some((node) => node.id === `${block.id}-op-${stage}`),
      )
      check('B', `${testCase.name}: block ${block.id} operations rendered`, missing.length === 0, missing.join(', '))
      check(
        'B',
        `${testCase.name}: block ${block.id} result node present`,
        snapshot.nodes.some((node) => node.id === `${block.id}-data-${block.stages[block.stages.length - 1]}`),
      )
    }
    graphInvariants('B', testCase.name, state, snapshot)
    report.artifacts.push(await page.screenshot(`B-${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`))
  }

  const compoundCases = [
    { name: 'UNION', sql: 'SELECT id FROM employees UNION SELECT id FROM departments;' },
    { name: 'UNION ALL', sql: 'SELECT id FROM employees UNION ALL SELECT id FROM departments;' },
    { name: 'INTERSECT', sql: 'SELECT id FROM employees INTERSECT SELECT id FROM departments;' },
    { name: 'EXCEPT', sql: 'SELECT id FROM employees EXCEPT SELECT id FROM departments;' },
    {
      name: 'mixed compound chain',
      sql: 'SELECT id FROM employees UNION ALL SELECT id FROM departments INTERSECT SELECT id FROM employees EXCEPT SELECT id FROM projects;',
    },
  ]

  for (const testCase of compoundCases) {
    const state = await visualizeOk(page, testCase.sql)
    await jumpToFinal(page)
    const snapshot = await canvasSnapshot(page)
    const operations = state.trace.compound ?? []
    check('B', `${testCase.name}: trace records compound operations`, operations.length > 0, operations.map((operation) => operation.id).join(', '))
    const renderedCompound = snapshot.nodes.filter((node) => node.kind === 'operation' && node.stage === 'COMPOUND')
    check(
      'B',
      `${testCase.name}: one operation node per compound step`,
      renderedCompound.length === operations.length,
      `${renderedCompound.length} rendered / ${operations.length} in trace`,
    )
    check('B', `${testCase.name}: compound result is the single final node`, snapshot.nodes.filter((node) => node.kind === 'final').length === 1)
    graphInvariants('B', testCase.name, state, snapshot)
    report.artifacts.push(await page.screenshot(`B-${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`))
  }

  // Empty result must still be a completed, honest visualization.
  section('Checkpoint B — empty result honesty')
  const emptyState = await visualizeOk(page, 'SELECT * FROM employees WHERE 1 = 0;')
  const emptySnapshot = await canvasSnapshot(page)
  check('B', 'empty result: trace is complete', emptyState.trace.finalRows === 0, `${emptyState.trace.finalRows} rows`)
  check('B', 'empty result: final node is present', emptySnapshot.nodes.filter((node) => node.kind === 'final').length === 1)
  await jumpToFinal(page)
  const emptyPlayback = await page.evaluate(`window.__sqlviz.getPlayback()`)
  const emptyCompleted = await canvasSnapshot(page)
  check('B', 'empty result: playback reaches a completed final node', emptyPlayback.finished === true && emptyCompleted.nodes.find((node) => node.kind === 'final')?.status === 'completed', `finished=${emptyPlayback.finished} status=${emptyCompleted.nodes.find((node) => node.kind === 'final')?.status}`)
  graphInvariants('B', 'empty result', emptyState, emptyCompleted)
  report.artifacts.push(await page.screenshot('B-empty-result.png'))

  // Correlated subqueries are a documented limitation: the visualization must
  // be refused honestly and leave no partial graph behind.
  const correlated = await visualize(
    page,
    'SELECT name FROM employees e WHERE EXISTS (SELECT 1 FROM employee_projects p WHERE p.employee_id = e.id);',
  )
  check(
    'B',
    'correlated EXISTS is refused honestly',
    correlated.status === 'unsupported' &&
      correlated.trace === null &&
      correlated.unavailableReasons.join(' ').toLowerCase().includes('correlated'),
    correlated.unavailableReasons.join('; ').slice(0, 160),
  )
  const correlatedCanvas = await canvasSnapshot(page)
  check('B', 'refused visualization leaves no partial graph', correlatedCanvas.nodes.length === 0, `${correlatedCanvas.nodes.length} nodes`)
}

// ---------------------------------------------------------------------------
// Checkpoint C — DML / DDL and preview safety
// ---------------------------------------------------------------------------

/** Full live-database capture: catalog plus every table's rows. */
async function captureDatabase(page) {
  return page.evaluate(`(() => {
    const schema = window.__sqlviz.query(
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name',
    )
    if (schema === null) return null
    const tables = {}
    for (const row of schema.values) {
      if (row[0] !== 'table') continue
      const name = String(row[1])
      const quoted = '"' + name.replace(/"/g, '""') + '"'
      const data = window.__sqlviz.query('SELECT * FROM ' + quoted)
      tables[name] =
        data === null
          ? null
          : {
              columns: data.columns,
              rows: data.values.map((values) => JSON.stringify(values)).sort(),
            }
    }
    return { activeId: window.__sqlviz.getActiveDatabaseId(), schema: schema.values, tables }
  })()`)
}

function canonicalDatabase(capture) {
  if (capture === null) return 'null'
  return JSON.stringify({ schema: capture.schema, tables: capture.tables })
}

const DML_CASES = [
  {
    name: 'INSERT VALUES',
    sql: "INSERT INTO projects (id, project_name, department_id, budget) VALUES (99, 'QA Project', 1, 1000)",
    expectAffected: 1,
  },
  {
    name: 'INSERT SELECT',
    sql: 'INSERT INTO projects (id, project_name, department_id, budget) SELECT id + 200, name, department_id, salary FROM employees WHERE id <= 2',
    expectAffected: 2,
  },
  {
    name: 'UPDATE changed rows',
    sql: 'UPDATE employees SET salary = salary + 1000 WHERE department_id = 1',
    expectAffectedSql: 'SELECT COUNT(*) FROM employees WHERE department_id = 1',
    expectUnchanged: 0,
  },
  {
    name: 'UPDATE matched but unchanged',
    sql: "UPDATE employees SET name = 'Rahul' WHERE id = 1",
    expectAffected: 1,
    expectChanged: 0,
    expectUnchanged: 1,
  },
  {
    name: 'UPDATE zero matching rows',
    sql: 'UPDATE employees SET salary = 0 WHERE id = 9999',
    expectAffected: 0,
  },
  {
    name: 'DELETE matching rows',
    sql: 'DELETE FROM employee_projects WHERE project_id = 1',
    expectAffectedSql: 'SELECT COUNT(*) FROM employee_projects WHERE project_id = 1',
  },
  {
    name: 'DELETE zero matching rows',
    sql: 'DELETE FROM employee_projects WHERE id = 9999',
    expectAffected: 0,
  },
]

const DDL_CASES = [
  {
    name: 'CREATE TABLE',
    sql: 'CREATE TABLE qa_notes (id INTEGER PRIMARY KEY, body TEXT)',
    finalLabel: 'Resulting schema',
    afterTable: 'qa_notes',
  },
  {
    name: 'ALTER TABLE ADD COLUMN',
    sql: "ALTER TABLE employees ADD COLUMN qa_note TEXT DEFAULT 'pending'",
    finalLabel: 'Resulting schema',
    afterTable: 'employees',
  },
  {
    name: 'ALTER TABLE RENAME COLUMN',
    sql: 'ALTER TABLE employees RENAME COLUMN city TO town',
    finalLabel: 'Resulting schema',
    afterTable: 'employees',
  },
  {
    name: 'ALTER TABLE DROP COLUMN',
    sql: 'ALTER TABLE employees DROP COLUMN city',
    finalLabel: 'Resulting schema',
    afterTable: 'employees',
  },
  {
    name: 'ALTER TABLE RENAME TO',
    sql: 'ALTER TABLE projects RENAME TO qa_projects',
    finalLabel: 'Resulting schema',
    afterTable: 'qa_projects',
  },
  {
    name: 'DROP TABLE',
    sql: 'DROP TABLE employee_projects',
    finalLabel: 'Resulting schema',
  },
  {
    name: 'CREATE INDEX',
    sql: 'CREATE INDEX qa_employees_name ON employees(name)',
    finalLabel: 'Index metadata',
    afterIndex: 'qa_employees_name',
  },
  {
    name: 'DROP INDEX (missing, IF EXISTS)',
    sql: 'DROP INDEX IF EXISTS qa_missing_index',
    finalLabel: 'Remaining indexes',
    noOp: true,
  },
]

const DDL_NOOP_CASES = [
  { name: 'CREATE TABLE IF NOT EXISTS (existing)', sql: 'CREATE TABLE IF NOT EXISTS employees (unused TEXT)' },
  { name: 'DROP TABLE IF EXISTS (missing)', sql: 'DROP TABLE IF EXISTS qa_missing_table' },
]

async function checkpointC(page, report) {
  section('Checkpoint C — DML / DDL visualization and preview safety')

  const baseline = await captureDatabase(page)

  for (const testCase of DML_CASES) {
    const before = await captureDatabase(page)
    const state = await visualizeOk(page, testCase.sql)
    await jumpToFinal(page)
    const snapshot = await canvasSnapshot(page)
    const dml = state.trace.dml

    check('C', `${testCase.name}: recognized as a DML preview`, state.trace.isDml === true && dml !== null)
    check(
      'C',
      `${testCase.name}: target table is a source node`,
      snapshot.nodes.some((node) => node.kind === 'source' && node.stage === 'TARGET'),
    )
    check('C', `${testCase.name}: target rows rendered exactly once`, snapshot.nodes.filter((node) => node.id === 'data-TARGET').length === 1)
    check(
      'C',
      `${testCase.name}: no redundant TARGET operation node`,
      !snapshot.nodes.some((node) => node.kind === 'operation' && node.stage === 'TARGET'),
    )
    const ops = operationStages(snapshot)
    // TARGET is a source-like table snapshot, not an operation node.
    const expectedOps = state.trace.stages.filter((stage) => stage !== 'TARGET')
    check(
      'C',
      `${testCase.name}: operation nodes match the trace`,
      JSON.stringify(ops) === JSON.stringify(expectedOps),
      `rendered ${JSON.stringify(ops)} / trace ${JSON.stringify(state.trace.stages)}`,
    )
    const finalNode = snapshot.nodes.find((node) => node.kind === 'final')
    check('C', `${testCase.name}: final table node present`, finalNode?.label === 'Final table', `${finalNode?.label}`)
    graphInvariants('C', testCase.name, state, snapshot)

    if (testCase.expectAffectedSql !== undefined) {
      const expected = await page.evaluate(`window.__sqlviz.query(${JSON.stringify(testCase.expectAffectedSql)}).values[0][0]`)
      check('C', `${testCase.name}: reports the real affected row count`, dml.affectedRowCount === expected, `${dml.affectedRowCount} vs live count ${expected}`)
    }
    if (testCase.expectUnchanged !== undefined) {
      check('C', `${testCase.name}: unchanged rows counted honestly`, dml.unchanged === testCase.expectUnchanged, `${dml.unchanged} unchanged`)
    }
    if (testCase.expectChanged !== undefined) {
      check('C', `${testCase.name}: changed rows counted honestly`, dml.changed === testCase.expectChanged, `${dml.changed} changed`)
    }

    const after = await captureDatabase(page)
    check('C', `${testCase.name}: preview leaves the live database untouched`, canonicalDatabase(before) === canonicalDatabase(after))
    check('C', `${testCase.name}: active database selection unchanged`, after.activeId === before.activeId)
    report.artifacts.push(await page.screenshot(`C-${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`))
  }

  for (const testCase of DDL_CASES) {
    const before = await captureDatabase(page)
    const state = await visualizeOk(page, testCase.sql)
    await jumpToFinal(page)
    const snapshot = await canvasSnapshot(page)
    const ddl = state.trace.ddl

    check('C', `${testCase.name}: recognized as a DDL preview`, state.trace.isDdl === true && ddl !== null)
    const ops = operationStages(snapshot)
    check(
      'C',
      `${testCase.name}: operation nodes match the trace`,
      JSON.stringify(ops) === JSON.stringify(state.trace.stages),
      `rendered ${JSON.stringify(ops)} / trace ${JSON.stringify(state.trace.stages)}`,
    )
    const finalNode = snapshot.nodes.find((node) => node.kind === 'final')
    check('C', `${testCase.name}: final schema node present`, finalNode?.label === testCase.finalLabel, `${finalNode?.label} vs ${testCase.finalLabel}`)
    graphInvariants('C', testCase.name, state, snapshot)
    if (testCase.afterTable !== undefined) {
      check('C', `${testCase.name}: preview result names the right table`, ddl.afterTable === testCase.afterTable, `${ddl.afterTable}`)
    }
    if (testCase.afterIndex !== undefined) {
      check('C', `${testCase.name}: preview result names the right index`, ddl.afterIndex === testCase.afterIndex, `${ddl.afterIndex}`)
    }
    if (testCase.noOp === true) {
      check('C', `${testCase.name}: no-op is reported honestly`, ddl.noOp === true)
    }

    const after = await captureDatabase(page)
    check('C', `${testCase.name}: preview leaves the live schema untouched`, canonicalDatabase(before) === canonicalDatabase(after))
    check('C', `${testCase.name}: active database selection unchanged`, after.activeId === before.activeId)
    report.artifacts.push(await page.screenshot(`C-${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`))
  }

  for (const testCase of DDL_NOOP_CASES) {
    const before = await captureDatabase(page)
    const state = await visualizeOk(page, testCase.sql)
    await jumpToFinal(page)
    const snapshot = await canvasSnapshot(page)
    check('C', `${testCase.name}: flagged as a no-op`, state.trace.ddl?.noOp === true)
    check('C', `${testCase.name}: still completes with one final node`, snapshot.nodes.filter((node) => node.kind === 'final').length === 1)
    graphInvariants('C', testCase.name, state, snapshot)
    const after = await captureDatabase(page)
    check('C', `${testCase.name}: live database untouched`, canonicalDatabase(before) === canonicalDatabase(after))
    report.artifacts.push(await page.screenshot(`C-${testCase.name.replace(/[^a-z0-9]+/gi, '-')}.png`))
  }

  // Persistence: a reload restores from IndexedDB. Previewing must not have
  // changed what was persisted.
  await page.reload()
  await preparePage(page)
  const reloaded = await captureDatabase(page)
  check('C', 'previews do not change the persisted database', canonicalDatabase(reloaded) === canonicalDatabase(baseline))
  check('C', 'active database restored after reload', reloaded.activeId === baseline.activeId, `${reloaded.activeId}`)
  report.artifacts.push(await page.screenshot('C-after-reload.png'))

  // Normal writable Run path must still mutate the real database.
  section('Checkpoint C — normal writable Run')
  const historyBefore = await page.evaluate(`window.__sqlviz.history().length`)
  await page.evaluate(`window.__sqlviz.setView('query')`)
  await page.evaluate(`window.__sqlviz.setEditor('UPDATE employees SET salary = 50000 WHERE id = 1')`)
  await sleep(200)
  await page.clickByText('Run')
  await page.waitFor(`window.__sqlviz.history().length > ${historyBefore}`, { label: 'run recorded', timeout: 20_000 })
  await sleep(300)
  const salary = await page.evaluate(`window.__sqlviz.query('SELECT salary FROM employees WHERE id = 1').values[0][0]`)
  check('C', 'Run writes to the real database', salary === 50000, `salary=${salary}`)

  // Preview must not have applied the same change earlier.
  const afterRun = await captureDatabase(page)
  check('C', 'writable Run is the only thing that changed data', canonicalDatabase(afterRun) !== canonicalDatabase(baseline))

  // Reset restores the seeded template.
  await page.evaluate(`window.__sqlviz.resetDatabase()`)
  await page.waitFor(`window.__sqlviz.query('SELECT salary FROM employees WHERE id = 1')?.values[0][0] === 45000`, {
    label: 'database reset',
    timeout: 30_000,
  })
  const reset = await captureDatabase(page)
  check('C', 'reset restores the seeded database', canonicalDatabase(reset) === canonicalDatabase(baseline))

  // Real index drop: create it writable, preview the drop, then run it.
  await page.evaluate(`window.__sqlviz.setEditor('CREATE INDEX qa_tmp_index ON employees(name)')`)
  await sleep(200)
  const historyBeforeIndex = await page.evaluate(`window.__sqlviz.history().length`)
  await page.clickByText('Run')
  await page.waitFor(`window.__sqlviz.history().length > ${historyBeforeIndex}`, { label: 'index created', timeout: 20_000 })
  await sleep(200)
  const indexExists = await page.evaluate(
    `window.__sqlviz.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'qa_tmp_index'").values.length`,
  )
  check('C', 'writable Run creates the QA index', indexExists === 1)

  // A genuinely existing index makes CREATE INDEX IF NOT EXISTS a real no-op.
  const afterIndexCreate = await captureDatabase(page)
  const indexNoOp = await visualizeOk(page, 'CREATE INDEX IF NOT EXISTS qa_tmp_index ON employees(name)')
  await jumpToFinal(page)
  const indexNoOpSnapshot = await canvasSnapshot(page)
  check('C', 'CREATE INDEX IF NOT EXISTS (existing index) is a no-op', indexNoOp.trace.ddl?.noOp === true)
  graphInvariants('C', 'CREATE INDEX IF NOT EXISTS (existing index)', indexNoOp, indexNoOpSnapshot)
  check(
    'C',
    'CREATE INDEX IF NOT EXISTS leaves the real index',
    canonicalDatabase(await captureDatabase(page)) === canonicalDatabase(afterIndexCreate),
  )
  report.artifacts.push(await page.screenshot('C-create-index-noop.png'))

  const beforeDrop = await captureDatabase(page)
  const dropState = await visualizeOk(page, 'DROP INDEX qa_tmp_index')
  await jumpToFinal(page)
  const dropSnapshot = await canvasSnapshot(page)
  check('C', 'DROP INDEX preview is recognized', dropState.trace.ddl?.noOp === false)
  check('C', 'DROP INDEX preview shows the remaining indexes', dropSnapshot.nodes.find((node) => node.kind === 'final')?.label === 'Remaining indexes')
  const afterDropPreview = await captureDatabase(page)
  check('C', 'DROP INDEX preview keeps the real index', canonicalDatabase(beforeDrop) === canonicalDatabase(afterDropPreview))
  report.artifacts.push(await page.screenshot('C-drop-index-preview.png'))

  await page.evaluate(`window.__sqlviz.setView('query')`)
  await page.evaluate(`window.__sqlviz.setEditor('DROP INDEX qa_tmp_index')`)
  await sleep(200)
  const historyBeforeDrop = await page.evaluate(`window.__sqlviz.history().length`)
  await page.clickByText('Run')
  await page.waitFor(`window.__sqlviz.history().length > ${historyBeforeDrop}`, { label: 'index dropped', timeout: 20_000 })
  await sleep(200)
  const indexGone = await page.evaluate(
    `window.__sqlviz.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'qa_tmp_index'").values.length`,
  )
  check('C', 'writable Run drops the QA index', indexGone === 0)
  await page.evaluate(`window.__sqlviz.resetDatabase()`)
  await page.waitFor(`window.__sqlviz.query('SELECT salary FROM employees WHERE id = 1')?.values[0][0] === 45000`, {
    label: 'final reset',
    timeout: 30_000,
  })
  check('C', 'database restored after writable tests', canonicalDatabase(await captureDatabase(page)) === canonicalDatabase(baseline))
}

// ---------------------------------------------------------------------------
// Checkpoint D — Canvas interactions, inspector and playback
// ---------------------------------------------------------------------------

/** Camera transform plus canvas viewport. */
async function camera(page) {
  return page.evaluate(`(() => {
    const surface = document.querySelector('[role="application"]')
    if (surface === null) return null
    const inner = surface.firstElementChild
    const rect = surface.getBoundingClientRect()
    const raw = inner === null ? 'none' : getComputedStyle(inner).transform
    const match = /matrix\\(([^)]+)\\)/.exec(raw)
    const parts = match === null ? [1, 0, 0, 1, 0, 0] : match[1].split(',').map(Number)
    const label = document.querySelector('[aria-label="Zoom in"]')?.previousElementSibling?.textContent ?? ''
    return {
      zoom: parts[0],
      panX: parts[4],
      panY: parts[5],
      zoomLabel: label.trim(),
      canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    }
  })()`)
}

const centerOf = (node) => ({ x: node.rect.x + node.rect.width / 2, y: node.rect.y + node.rect.height / 2 })
const findNode = (snapshot, id) => snapshot.nodes.find((node) => node.id === id)

async function checkpointD(page, report) {
  section('Checkpoint D — Canvas interactions, inspector and playback')

  await visualizeOk(
    page,
    'SELECT e.name, d.department_name FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.salary > 20000 ORDER BY e.name;',
  )
  await jumpToFinal(page)
  await page.click('[aria-label="Reset view"]')
  await sleep(350)

  // The completed graph is the authoritative node set for the whole session.
  const fullNodeIds = (await canvasSnapshot(page)).nodes.map((node) => node.id).sort()

  // --- Zoom ---------------------------------------------------------------
  const startCamera = await camera(page)
  const startNodes = await canvasSnapshot(page)
  const anchor = startNodes.nodes.find((node) => node.id === 'final') ?? startNodes.nodes[startNodes.nodes.length - 1]
  const zoomPoint = { x: startCamera.canvas.x + 60, y: startCamera.canvas.y + 70 }
  const anchorBefore = centerOf(anchor)

  for (let step = 0; step < 3; step += 1) {
    await page.wheel(zoomPoint.x, zoomPoint.y, -120)
    await sleep(90)
  }
  await sleep(300)
  const zoomedCamera = await camera(page)
  const zoomedNodes = await canvasSnapshot(page)
  const anchorAfterNode = findNode(zoomedNodes, anchor.id)
  check('D', 'mouse-wheel zoom changes the camera scale', zoomedCamera.zoom > startCamera.zoom + 0.05, `${startCamera.zoomLabel} → ${zoomedCamera.zoomLabel}`)

  if (anchorAfterNode !== undefined) {
    const anchorAfter = centerOf(anchorAfterNode)
    const expectedRatio = zoomedCamera.zoom / startCamera.zoom
    const actualRatio = (anchorAfter.x - zoomPoint.x) / (anchorBefore.x - zoomPoint.x)
    check(
      'D',
      'zoom is anchored at the pointer position',
      Math.abs(actualRatio - expectedRatio) < 0.15 * expectedRatio,
      `ratio ${actualRatio.toFixed(2)} vs zoom ratio ${expectedRatio.toFixed(2)}`,
    )
  }

  for (let step = 0; step < 3; step += 1) {
    await page.wheel(zoomPoint.x, zoomPoint.y, 120)
    await sleep(90)
  }
  await sleep(250)
  const restoredCamera = await camera(page)
  check('D', 'zooming back restores the previous scale', Math.abs(restoredCamera.zoom - startCamera.zoom) < 0.02, `${restoredCamera.zoomLabel}`)

  await page.click('[aria-label="Fit to screen"]')
  await sleep(350)
  const fitted = await camera(page)
  const fittedNodes = await canvasSnapshot(page)
  const outside = fittedNodes.nodes.filter(
    (node) =>
      node.visible &&
      (node.rect.x < fitted.canvas.x - 3 ||
        node.rect.right > fitted.canvas.x + fitted.canvas.width + 3 ||
        node.rect.y < fitted.canvas.y - 3 ||
        node.rect.bottom > fitted.canvas.y + fitted.canvas.height + 3),
  )
  check('D', 'fit-to-screen keeps every node inside the canvas', outside.length === 0, outside.map((node) => node.id).join(', '))

  await page.click('[aria-label="Reset view"]')
  await sleep(300)
  const resetCamera = await camera(page)
  const resetNodesForCamera = await canvasSnapshot(page)
  const topMostResetNode = Math.min(
    ...resetNodesForCamera.nodes.filter((node) => node.visible).map((node) => node.rect.y),
  )
  check(
    'D',
    'reset view frames the graph from the top',
    resetCamera.zoom <= 1.0001 &&
      topMostResetNode >= resetCamera.canvas.y - 2 &&
      topMostResetNode <= resetCamera.canvas.y + 64,
    `zoom=${resetCamera.zoomLabel} top=${Math.round(topMostResetNode - resetCamera.canvas.y)}px`,
  )

  // --- Pan ----------------------------------------------------------------
  const panStart = await camera(page)
  const emptyPoint = { x: panStart.canvas.x + 36, y: panStart.canvas.y + 36 }
  await page.drag(emptyPoint, { x: emptyPoint.x + 120, y: emptyPoint.y + 70 })
  await sleep(250)
  const panned = await camera(page)
  check(
    'D',
    'dragging empty canvas pans the camera',
    Math.abs(panned.panX - panStart.panX - 120) < 10 && Math.abs(panned.panY - panStart.panY - 70) < 10,
    `Δ(${Math.round(panned.panX - panStart.panX)}, ${Math.round(panned.panY - panStart.panY)})`,
  )

  const panBeforeShift = await camera(page)
  await page.wheel(panBeforeShift.canvas.x + 200, panBeforeShift.canvas.y + 200, 120, { modifiers: 8 })
  await sleep(200)
  const panAfterShift = await camera(page)
  check('D', 'shift+wheel pans horizontally', Math.abs(panAfterShift.panX - panBeforeShift.panX) > 4, `Δx ${Math.round(panAfterShift.panX - panBeforeShift.panX)}`)

  // --- Node drag and click threshold --------------------------------------
  await page.click('[aria-label="Reset view"]')
  await sleep(300)
  const dragStartNodes = await canvasSnapshot(page)
  const dragTarget = dragStartNodes.nodes.find((node) => node.kind === 'operation')
  const dragCamera = await camera(page)
  const dragFrom = centerOf(dragTarget)
  await page.drag(dragFrom, { x: dragFrom.x + 70, y: dragFrom.y + 40 })
  await sleep(300)
  const afterNodeDrag = await canvasSnapshot(page)
  const dragCameraAfter = await camera(page)
  const moved = findNode(afterNodeDrag, dragTarget.id)
  const expectedDx = 70 / dragCamera.zoom
  check(
    'D',
    'dragging a node moves it with the pointer',
    Math.abs(moved.rect.x - dragTarget.rect.x - expectedDx) < 16,
    `Δx ${Math.round(moved.rect.x - dragTarget.rect.x)} expected ~${Math.round(expectedDx)}`,
  )
  check('D', 'dragging a node does not pan the canvas', Math.abs(dragCameraAfter.panX - dragCamera.panX) < 2 && Math.abs(dragCameraAfter.panY - dragCamera.panY) < 2)

  // Negative-coordinate layout: a node can be dragged left of the graph
  // origin and keeps that placement through camera changes.
  const graphPoint = (cameraState, rect) => ({
    x: (rect.x - cameraState.canvas.x - cameraState.panX) / cameraState.zoom,
    y: (rect.y - cameraState.canvas.y - cameraState.panY) / cameraState.zoom,
  })
  const negativeNodes = await canvasSnapshot(page)
  const negativeCamera = await camera(page)
  const negativeTarget = negativeNodes.nodes.find((node) => node.kind === 'operation' && node.visible)
  const negativeFrom = centerOf(negativeTarget)
  await page.drag(negativeFrom, { x: negativeCamera.canvas.x + 30, y: negativeFrom.y + 60 })
  await sleep(300)
  const afterNegative = await canvasSnapshot(page)
  const negativeAfter = findNode(afterNegative, negativeTarget.id)
  const negativeGraph = graphPoint(negativeCamera, negativeAfter.rect)
  check('D', 'a node can be dragged left of the graph origin', negativeGraph.x < 0, `graph x=${Math.round(negativeGraph.x)}`)
  await page.click('[aria-label="Reset view"]')
  await sleep(350)
  const resetCameraForNode = await camera(page)
  const resetNodes = await canvasSnapshot(page)
  const negativeReset = graphPoint(resetCameraForNode, findNode(resetNodes, negativeTarget.id).rect)
  check(
    'D',
    'negative-coordinate placement survives a camera reset',
    Math.abs(negativeReset.x - negativeGraph.x) < 2 && Math.abs(negativeReset.y - negativeGraph.y) < 2,
    `(${Math.round(negativeGraph.x)}, ${Math.round(negativeGraph.y)}) → (${Math.round(negativeReset.x)}, ${Math.round(negativeReset.y)})`,
  )

  // A tiny movement is still a click, not a drag.
  // Re-read the target after the negative-coordinate drag and camera reset;
  // its earlier screen rectangle is no longer a valid hit target.
  const clickTargetId = (afterNodeDrag.nodes.find((node) => node.kind === 'operation' && node.id !== dragTarget.id) ?? moved).id
  const clickTarget = findNode(resetNodes, clickTargetId)
  if (clickTarget === undefined) throw new Error(`Click target disappeared: ${clickTargetId}`)
  const beforeClickPosition = centerOf(clickTarget)
  await page.drag(beforeClickPosition, { x: beforeClickPosition.x + 2, y: beforeClickPosition.y + 1 }, { steps: 2 })
  await sleep(250)
  const clickCamera = await camera(page)
  void clickCamera
  const selectedAfterTinyMove = await page.evaluate(`document.querySelector('[role="application"]').getAttribute('data-selected-node')`)
  check('D', 'a sub-threshold move still selects the node', selectedAfterTinyMove === clickTarget.id, `selected=${selectedAfterTinyMove} expected=${clickTarget.id}`)

  // --- Hover upstream ------------------------------------------------------
  // Fit first so the hover target is guaranteed to be inside the viewport.
  await page.click('[aria-label="Fit to screen"]')
  await sleep(350)
  const fitCamera = await camera(page)
  const hoverSnapshot = await canvasSnapshot(page)
  const hoverTarget = hoverSnapshot.nodes.find(
    (node) =>
      node.kind === 'final' &&
      node.rect.y >= fitCamera.canvas.y &&
      node.rect.bottom <= fitCamera.canvas.y + fitCamera.canvas.height,
  )
  if (hoverTarget === undefined) throw new Error('Final node is not visible for the hover test')
  // Move to a neutral point first so the pointer actually enters the node.
  await page.hoverAt(fitCamera.canvas.x + 20, fitCamera.canvas.y + 20)
  await sleep(150)
  await page.hoverAt(centerOf(hoverTarget).x, centerOf(hoverTarget).y)
  await sleep(350)
  const hoverState = await page.evaluate(`(() => {
    const app = document.querySelector('[role="application"]')
    return { hovered: app.getAttribute('data-hovered-node'), mode: app.getAttribute('data-trace-mode') }
  })()`)
  check('D', 'hovering a node activates its upstream trace', hoverState.hovered === hoverTarget.id, `hovered=${hoverState.hovered} mode=${hoverState.mode}`)
  const upstreamNodes = (await canvasSnapshot(page)).nodes.filter((node) => node.upstream)
  check('D', 'hovering highlights upstream nodes', upstreamNodes.length > 0, `${upstreamNodes.length} upstream`)
  await page.hoverAt(fitCamera.canvas.x + 20, fitCamera.canvas.y + 20)
  await sleep(200)

  // --- Inspector -----------------------------------------------------------
  const inspectorTarget = (await canvasSnapshot(page)).nodes.find((node) => node.kind === 'operation')
  await page.clickAt(centerOf(inspectorTarget).x, centerOf(inspectorTarget).y)
  await page.waitFor(`Boolean(document.querySelector('[role="dialog"][aria-label="Node inspector"]'))`, { label: 'inspector open' })
  await sleep(250)
  check('D', 'clicking a node opens the Node Inspector', true)

  const inspectorRects = await page.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Node inspector"]')
    const rect = dialog.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)

  for (const tab of ['overview', 'input', 'output', 'details']) {
    await page.click(`#inspector-tab-${tab}`)
    await sleep(120)
    const active = await page.evaluate(`document.querySelector('#inspector-tab-${tab}').getAttribute('aria-selected')`)
    const panel = await page.evaluate(`Boolean(document.querySelector('#inspector-panel-${tab}'))`)
    check('D', `inspector ${tab} tab activates`, active === 'true' && panel)
  }

  // Drag the inspector by its header. It is clamped to the workspace, so
  // move it upward first to guarantee headroom.
  const headerPoint = await page.rect('[data-testid="node-inspector-header"]')
  await page.drag({ x: headerPoint.x, y: headerPoint.y }, { x: headerPoint.x, y: headerPoint.y - 180 })
  await sleep(250)
  const raisedInspector = await page.evaluate(`(() => {
    const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  check(
    'D',
    'inspector can be dragged by its header',
    Math.abs(raisedInspector.y - inspectorRects.y + 180) < 14,
    `Δ(${Math.round(raisedInspector.x - inspectorRects.x)}, ${Math.round(raisedInspector.y - inspectorRects.y)})`,
  )

  // Resize from the bottom-right handle (there is headroom after raising it).
  const resizeHandle = await page.rect('[role="dialog"][aria-label="Node inspector"] [data-edge="se"]')
  if (resizeHandle !== null) {
    const beforeResize = await page.evaluate(`(() => {
      const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })()`)
    await page.drag(
      { x: resizeHandle.x, y: resizeHandle.y },
      { x: resizeHandle.x + 60, y: resizeHandle.y + 50 },
    )
    await sleep(250)
    const afterResize = await page.evaluate(`(() => {
      const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })()`)
    check(
      'D',
      'inspector can be resized from its corner',
      afterResize.width > beforeResize.width + 20 && afterResize.height > beforeResize.height + 20,
      `${Math.round(beforeResize.width)}×${Math.round(beforeResize.height)} → ${Math.round(afterResize.width)}×${Math.round(afterResize.height)}`,
    )
  } else {
    check('D', 'inspector can be resized from its corner', false, 'resize handle missing')
  }

  // Dragging back down must follow the pointer vertically. Horizontal travel
  // depends on the actual space remaining before the workspace's right bound.
  const headerAgain = await page.rect('[data-testid="node-inspector-header"]')
  const beforeDownDrag = await page.evaluate(`(() => {
    const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
    const layer = document.querySelector('[data-inspector-layer]').getBoundingClientRect()
    return { x: rect.x, y: rect.y, availableRight: Math.max(0, layer.right - rect.right) }
  })()`)
  await page.drag({ x: headerAgain.x, y: headerAgain.y }, { x: headerAgain.x + 60, y: headerAgain.y + 50 })
  await sleep(250)
  const afterDownDrag = await page.evaluate(`(() => {
    const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })()`)
  const expectedRightTravel = Math.min(60, beforeDownDrag.availableRight)
  check(
    'D',
    'inspector follows the pointer within its bounds',
    Math.abs(afterDownDrag.x - beforeDownDrag.x - expectedRightTravel) < 2 && Math.abs(afterDownDrag.y - beforeDownDrag.y - 50) < 14,
    `Δ(${Math.round(afterDownDrag.x - beforeDownDrag.x)}, ${Math.round(afterDownDrag.y - beforeDownDrag.y)}) expected Δx=${Math.round(expectedRightTravel)}`,
  )

  // The inspector must not follow Canvas panning.
  const inspectorBeforePan = await page.evaluate(`(() => {
    const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })()`)
  const cameraBeforeInspectorPan = await camera(page)
  const panPoint = { x: cameraBeforeInspectorPan.canvas.x + 30, y: cameraBeforeInspectorPan.canvas.y + 30 }
  await page.drag(panPoint, { x: panPoint.x + 80, y: panPoint.y + 40 })
  await sleep(250)
  const inspectorAfterPan = await page.evaluate(`(() => {
    const rect = document.querySelector('[role="dialog"][aria-label="Node inspector"]').getBoundingClientRect()
    return { x: rect.x, y: rect.y }
  })()`)
  check(
    'D',
    'inspector stays put while the Canvas pans',
    Math.abs(inspectorAfterPan.x - inspectorBeforePan.x) < 2 && Math.abs(inspectorAfterPan.y - inspectorBeforePan.y) < 2,
  )

  // Minimize, then restore from the dock.
  await page.click('[aria-label="Minimize node inspector"]')
  await sleep(250)
  const minimized = await page.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Node inspector"]')
    return {
      hidden: dialog === null || getComputedStyle(dialog).display === 'none' || dialog.getAttribute('aria-hidden') === 'true',
      dock: Boolean(document.querySelector('[data-testid="inspector-dock"]')),
    }
  })()`)
  check('D', 'minimizing hides the inspector and shows the dock', minimized.hidden && minimized.dock, JSON.stringify(minimized))
  const restoreButton = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-testid="inspector-dock"] button')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? '').startsWith('Restore inspector for'))
    return button !== null && button !== undefined
  })()`)
  check('D', 'dock offers a restore action', restoreButton === true)
  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-testid="inspector-dock"] button')]
      .find((candidate) => (candidate.getAttribute('aria-label') ?? '').startsWith('Restore inspector for'))
    button?.click()
  })()`)
  await sleep(250)
  const restoredDialog = await page.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Node inspector"]')
    return dialog !== null && getComputedStyle(dialog).display !== 'none'
  })()`)
  check('D', 'inspector restores from the dock', restoredDialog === true)

  await page.click('[aria-label="Close node inspector"]')
  await sleep(250)
  const closed = await page.evaluate(`document.querySelector('[role="dialog"][aria-label="Node inspector"]') === null`)
  check('D', 'inspector closes', closed === true)

  // --- Playback ------------------------------------------------------------
  await page.click('[aria-label="Restart visualization"]')
  await sleep(250)
  const playbackStart = await page.evaluate(`window.__sqlviz.getPlayback()`)
  check('D', 'restart returns playback to the first event', playbackStart.eventIndex === 0, `index=${playbackStart.eventIndex}`)

  await page.click('[aria-label="Next event"]')
  await sleep(150)
  await page.click('[aria-label="Next event"]')
  await sleep(150)
  const afterNext = await page.evaluate(`window.__sqlviz.getPlayback()`)
  check('D', 'next event advances playback', afterNext.eventIndex === 2, `index=${afterNext.eventIndex}`)

  await page.click('[aria-label="Previous event"]')
  await sleep(150)
  const afterPrevious = await page.evaluate(`window.__sqlviz.getPlayback()`)
  check('D', 'previous event rewinds playback', afterPrevious.eventIndex === 1, `index=${afterPrevious.eventIndex}`)

  // Seeking must never change the graph itself. Nodes that have not produced
  // data yet are intentionally hidden, so compare identity against the
  // completed graph rather than against DOM presence.
  const playbackNodeIds = []
  const playbackStatuses = []
  const seekIndexes = []
  for (const fraction of [0.25, 0.55, 0.85]) {
    const slider = await page.rect('input[aria-label="Timeline position"]')
    const x = slider.x - slider.width / 2 + slider.width * fraction
    await page.clickAt(x, slider.y)
    await sleep(250)
    const playback = await page.evaluate(`window.__sqlviz.getPlayback()`)
    seekIndexes.push(playback.eventIndex)
    const snapshot = await canvasSnapshot(page)
    playbackNodeIds.push(snapshot.nodes.map((node) => node.id).sort())
    playbackStatuses.push(snapshot.nodes.map((node) => node.status).join(','))
  }
  check(
    'D',
    'the timeline seeks to the clicked position',
    seekIndexes[0] < seekIndexes[1] && seekIndexes[1] < seekIndexes[2],
    JSON.stringify(seekIndexes),
  )
  const fullIdSet = new Set(fullNodeIds)
  const unknown = playbackNodeIds.flat().filter((id) => !fullIdSet.has(id))
  check('D', 'seeking never introduces nodes outside the graph', unknown.length === 0, unknown.join(', '))
  const duplicated = playbackNodeIds.flatMap((ids) => ids.filter((id, index) => ids.indexOf(id) !== index))
  check('D', 'seeking never duplicates a node', duplicated.length === 0, duplicated.join(', '))
  const union = new Set(playbackNodeIds.flat())
  check(
    'D',
    'seeking reveals the same graph, never a new one',
    union.size === fullNodeIds.length,
    `${union.size} of ${fullNodeIds.length} nodes revealed across samples`,
  )
  check('D', 'seeking changes node states rather than node structure', new Set(playbackStatuses).size > 1)

  await page.click('[aria-label="Jump to final result"]')
  await sleep(250)
  const finished = await page.evaluate(`window.__sqlviz.getPlayback()`)
  check('D', 'jump-to-final reaches completion', finished.finished === true && finished.eventIndex === finished.totalEvents - 1)
  const finalStatus = (await canvasSnapshot(page)).nodes.find((node) => node.kind === 'final')?.status
  check('D', 'final node completes at the end of playback', finalStatus === 'completed', `${finalStatus}`)

  const replayLabel = await page.evaluate(
    `document.querySelector('[aria-label="Replay"]') !== null || document.querySelector('[aria-label="Play"]') !== null`,
  )
  check('D', 'replay control is available after completion', replayLabel === true)
  await page.click('[aria-label="Replay"], [aria-label="Play"]')
  await sleep(400)
  const replaying = await page.evaluate(`window.__sqlviz.getPlayback()`)
  check('D', 'replay restarts playback from the beginning', replaying.playing === true && replaying.eventIndex < 4, `index=${replaying.eventIndex} playing=${replaying.playing}`)
  await page.click('[aria-label="Pause"]')
  await sleep(200)
  const paused = await page.evaluate(`window.__sqlviz.getPlayback()`)
  check('D', 'pause stops playback', paused.playing === false)

  report.artifacts.push(await page.screenshot('D-interactions.png'))

  // Changing the query after completion must replace the graph entirely.
  const beforeChange = (await canvasSnapshot(page)).nodes.map((node) => node.id)
  await visualizeOk(page, 'SELECT name FROM employees WHERE salary > 40000;')
  await jumpToFinal(page)
  const afterChange = await canvasSnapshot(page)
  const changedIds = afterChange.nodes.map((node) => node.id)
  check('D', 'visualizing a new query after completion replaces the graph', afterChange.nodes.filter((node) => node.kind === 'final').length === 1 && changedIds.join('|') !== beforeChange.join('|'))
  check('D', 'previous query nodes do not survive into the new graph', !changedIds.includes('op-JOIN'), changedIds.join(', '))
  graphInvariants('D', 'query changed after completion', await page.evaluate(`window.__sqlviz.getTrace()`), afterChange)
  report.artifacts.push(await page.screenshot('D-after-query-change.png'))
}

// ---------------------------------------------------------------------------
// Checkpoint E — visual quality, performance and regression sweep
// ---------------------------------------------------------------------------

const LARGE_QUERY = `SELECT e.name, d.department_name, p.project_name
FROM employees e
JOIN departments d ON d.id = e.department_id
JOIN employee_projects ep ON ep.employee_id = e.id
JOIN projects p ON p.id = ep.project_id
WHERE e.salary > 20000 AND d.location = 'Delhi'
ORDER BY e.name
LIMIT 10;`

async function checkpointE(page, report) {
  section('Checkpoint E — visual quality, performance and regression sweep')

  // --- Visual quality at three sizes --------------------------------------
  const visualCases = [
    { name: 'small', sql: 'SELECT name FROM employees WHERE id = 1;' },
    {
      name: 'medium',
      sql: 'SELECT d.department_name, COUNT(*) AS headcount FROM employees e JOIN departments d ON d.id = e.department_id GROUP BY d.department_name ORDER BY headcount DESC;',
    },
    { name: 'large', sql: LARGE_QUERY },
  ]

  for (const testCase of visualCases) {
    await visualizeOk(page, testCase.sql)
    await jumpToFinal(page)
    await page.click('[aria-label="Fit to screen"]')
    await sleep(400)
    const snapshot = await canvasSnapshot(page)
    const cameraState = await camera(page)

    check('E', `${testCase.name} graph: nodes rendered`, snapshot.nodes.length > 0, `${snapshot.nodes.length} nodes`)
    const overlapping = overlaps(snapshot)
    check('E', `${testCase.name} graph: no overlapping nodes at fit zoom`, overlapping.length === 0, overlapping.slice(0, 3).join('; '))
    const outside = snapshot.nodes.filter(
      (node) =>
        node.visible &&
        (node.rect.x < cameraState.canvas.x - 3 ||
          node.rect.right > cameraState.canvas.x + cameraState.canvas.width + 3 ||
          node.rect.y < cameraState.canvas.y - 3 ||
          node.rect.bottom > cameraState.canvas.y + cameraState.canvas.height + 3),
    )
    check('E', `${testCase.name} graph: fit-to-screen shows every node`, outside.length === 0, outside.map((node) => node.id).join(', '))

    // Titles must be readable: any visually truncated title must expose the
    // full text through its tooltip.
    const clippedTitles = await page.evaluate(`(() => {
      return [...document.querySelectorAll('[data-node-id]')]
        .map((node) => {
          const title = node.querySelector('.flow-node-title')
          if (title === null) return null
          const clipped = title.scrollWidth > title.clientWidth + 1
          const hasTooltip = (title.getAttribute('title') ?? '').length > 0
          return clipped && !hasTooltip ? node.getAttribute('data-node-id') : null
        })
        .filter(Boolean)
    })()`)
    check('E', `${testCase.name} graph: truncated titles keep a full-text tooltip`, clippedTitles.length === 0, clippedTitles.join(', '))
    check('E', `${testCase.name} graph: every node has a readable label`, snapshot.nodes.every((node) => node.label.length > 0))
    report.artifacts.push(await page.screenshot(`E-${testCase.name}-fit.png`))
  }

  // --- Performance --------------------------------------------------------
  const perfState = await (async () => {
    const started = Date.now()
    const state = await visualizeOk(page, LARGE_QUERY)
    await page.waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, { label: 'large graph', timeout: 20_000 })
    return { state, visualizeMs: Date.now() - started }
  })()
  check('E', 'large query visualizes within 5 seconds', perfState.visualizeMs < 5000, `${perfState.visualizeMs}ms`)
  report.metrics.largeVisualizeMs = perfState.visualizeMs

  await jumpToFinal(page)
  await page.click('[aria-label="Restart visualization"]')
  await sleep(200)

  // DOM identity must survive playback: React reuses node elements rather
  // than rebuilding the graph on every event.
  await page.evaluate(`(() => {
    const element = document.querySelector('[data-node-id="final"]')
    if (element !== null) element.dataset.qaMark = 'survives'
  })()`)
  const stepDurations = []
  for (let step = 0; step < 6; step += 1) {
    const started = Date.now()
    await page.click('[aria-label="Next event"]')
    await sleep(60)
    stepDurations.push(Date.now() - started)
  }
  const markerSurvived = await page.evaluate(
    `document.querySelector('[data-node-id="final"]')?.dataset.qaMark === 'survives'`,
  )
  check('E', 'playback reuses the same DOM nodes instead of rebuilding them', markerSurvived === true)
  const averageStep = stepDurations.reduce((total, value) => total + value, 0) / stepDurations.length
  check('E', 'playback steps stay responsive', averageStep < 400, `${Math.round(averageStep)}ms average`)
  report.metrics.playbackStepMs = Math.round(averageStep)

  // Repeated visualization must not accumulate nodes or leak DOM.
  const repeatedCounts = []
  const repeatStart = Date.now()
  for (let index = 0; index < 6; index += 1) {
    await visualizeOk(page, index % 2 === 0 ? LARGE_QUERY : 'SELECT name FROM employees WHERE salary > 35000;')
    repeatedCounts.push((await canvasSnapshot(page)).nodes.length)
  }
  const repeatMs = Date.now() - repeatStart
  check(
    'E',
    'repeated visualizations keep node counts bounded per query',
    new Set(repeatedCounts.filter((_, index) => index % 2 === 0)).size === 1 &&
      new Set(repeatedCounts.filter((_, index) => index % 2 === 1)).size === 1,
    JSON.stringify(repeatedCounts),
  )
  check('E', 'repeated visualizations stay responsive', repeatMs < 20_000, `${repeatMs}ms for 6 visualizations`)
  report.metrics.repeatVisualizeMs = repeatMs
  report.metrics.nodeCounts = repeatedCounts

  // --- Bundle -------------------------------------------------------------
  const assets = await page.evaluate(`performance.getEntriesByType('resource')
    .filter((entry) => entry.name.endsWith('.js'))
    .reduce((total, entry) => total + (entry.transferSize || 0), 0)`)
  report.metrics.initialJsTransfer = assets

  // Final regression sweep: the seeded database is still intact and the
  // console stayed clean throughout the whole suite.
  const finalDb = await captureDatabase(page)
  check('E', 'database remains complete at the end of the suite', Object.keys(finalDb.tables).length === 4, Object.keys(finalDb.tables).join(', '))
  check('E', 'employees table still has its seeded rows', finalDb.tables.employees?.rows.length === 8, `${finalDb.tables.employees?.rows.length}`)
  check('E', 'no console errors during the suite', report.consoleErrors.length === 0, report.consoleErrors.slice(0, 3).join(' | '))
  check('E', 'no console warnings during the suite', report.consoleWarnings.length === 0, report.consoleWarnings.slice(0, 3).map((entry) => entry.text).join(' | '))
  check('E', 'no uncaught exceptions during the suite', report.pageErrors.length === 0, report.pageErrors.slice(0, 2).join(' | '))
  check('E', 'no failed requests during the suite', report.failedRequests.length === 0, report.failedRequests.slice(0, 3).join(' | '))

  report.artifacts.push(await page.screenshot('E-final.png'))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true })
  let server = null
  if (process.env.QA_MANAGED_SERVER === '1') {
    server = await startServer()
  }

  const browser = await launchBrowser({ port: CDP_PORT })
  const report = {
    startedAt: new Date().toISOString(),
    appUrl: APP_URL,
    browserVersion: browser.version['User-Agent'],
    browserExecutable: browser.executable,
    checks: results,
    artifacts,
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
  }

  try {
    const page = await browser.openPage(APP_URL)
    await page.setArtifactDir(OUT)
    report.metrics = { appReadyMs: await preparePage(page) }

    const collect = () => {
      report.consoleErrors = page.consoleMessages.filter(
        (message) => message.type === 'error' || message.type === 'log-error',
      )
      report.consoleWarnings = page.consoleMessages.filter((message) => message.type === 'warning')
      report.pageErrors = [...page.pageErrors]
      report.failedRequests = page.failedRequests.map((entry) => `${entry.type}: ${entry.errorText}`)
      report.badResponses = page.badResponses.map((entry) => `${entry.status} ${entry.url}`)
    }

    if (requested.includes('A')) {
      await checkpointA(page, report)
      collect()
    }
    if (requested.includes('B')) {
      await checkpointB(page, report)
      collect()
    }
    if (requested.includes('C')) {
      await checkpointC(page, report)
      collect()
    }
    if (requested.includes('D')) {
      await checkpointD(page, report)
      collect()
    }
    if (requested.includes('E')) {
      await checkpointE(page, report)
      collect()
    }

    collect()
    page.close()
  } finally {
    await browser.close()
    await stopServer(server)
  }

  const failed = results.filter((record) => !record.ok)
  const summary = {
    ...report,
    finishedAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed,
  }
  await writeFile(join(OUT, 'report.json'), JSON.stringify(summary, null, 2))
  console.log(`\nRESULT ${summary.passed}/${summary.total} checks passed`)
  if (failed.length > 0) {
    console.log('FAILURES:')
    for (const failure of failed) console.log(` - [${failure.group}] ${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}`)
  }
  console.log(`Artifacts: ${OUT}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('QA suite crashed:', error)
  process.exitCode = 2
})
