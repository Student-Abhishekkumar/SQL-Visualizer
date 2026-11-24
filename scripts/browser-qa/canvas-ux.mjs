/**
 * Stage 9 Canvas UX verification: viewport-aware layout, fit-to-screen,
 * resize handling and navigation stability. Uses the same dependency-free
 * CDP driver as the main QA suite.
 *
 *   QA_MANAGED_SERVER=1 npm run qa:canvas
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', 'stage9')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const LARGE_JOIN = `SELECT e.name, d.department_name, p.project_name
FROM employees e
JOIN departments d ON d.id = e.department_id
JOIN employee_projects ep ON ep.employee_id = e.id
JOIN projects p ON p.id = ep.project_id
WHERE e.salary > 20000
ORDER BY e.name
LIMIT 10;`

const CASES = [
  { name: 'small', sql: 'SELECT name, salary FROM employees WHERE id = 1;' },
  { name: 'branch', sql: 'SELECT name FROM employees WHERE salary > 40000;' },
  { name: 'groupby', sql: 'SELECT department_id, COUNT(*) FROM employees GROUP BY department_id;' },
  {
    name: 'many-groups',
    sql: 'SELECT department_id, age, COUNT(*) FROM employees GROUP BY department_id, age;',
  },
  {
    name: 'join',
    sql: 'SELECT e.name, d.department_name FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.salary > 20000 ORDER BY e.name;',
  },
  {
    name: 'nested',
    sql: 'SELECT name, salary FROM employees WHERE salary > (SELECT AVG(salary) FROM employees);',
  },
  {
    name: 'cte',
    sql: 'WITH high AS (SELECT id, salary FROM employees WHERE salary > 50000), dbl AS (SELECT id, salary * 2 AS doubled FROM high) SELECT id, doubled FROM dbl ORDER BY id;',
  },
  {
    name: 'compound',
    sql: 'SELECT id FROM employees UNION ALL SELECT id FROM departments INTERSECT SELECT id FROM employees EXCEPT SELECT id FROM projects;',
  },
  { name: 'large', sql: LARGE_JOIN },
  { name: 'dml', sql: 'UPDATE employees SET salary = salary + 1 WHERE id = 1' },
  { name: 'delete', sql: 'DELETE FROM employee_projects WHERE project_id = 1' },
  { name: 'ddl', sql: 'CREATE INDEX qa_ux_idx ON employees(name)' },
  { name: 'ddl-alter', sql: 'ALTER TABLE employees ADD COLUMN qa_note TEXT' },
  { name: 'empty', sql: 'SELECT * FROM employees WHERE 1 = 0;' },
]

let server = null
if (process.env.QA_MANAGED_SERVER === '1') {
  server = spawn(
    process.execPath,
    [join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    { stdio: 'ignore', windowsHide: true },
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(URL)).ok) break
    } catch {
      /* starting */
    }
    await sleep(200)
  }
}

const browser = await launchBrowser({ port: Number(process.env.CDP_PORT ?? 9341) })
const consoleErrors = []
try {
  await mkdir(OUT, { recursive: true })
  const page = await browser.openPage(URL)
  await page.setArtifactDir(OUT)
  await page.waitFor(`Boolean(window.__sqlviz) && window.__sqlviz.databases().length > 0`, {
    label: 'app ready',
    timeout: 60_000,
  })
  await sleep(500)

  const normalizeSql = (value) =>
    String(value).replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase()

  const visualize = async (sql) => {
    const before = await page.evaluate('window.__sqlviz.getTrace().sessionId')
    const idsBefore = await page.evaluate(
      `[...document.querySelectorAll('[data-node-id]')].map((el) => el.getAttribute('data-node-id')).join('|')`,
    )
    await page.evaluate(`window.__sqlviz.setView('query')`)
    await sleep(120)
    await page.evaluate(`window.__sqlviz.setEditor(${JSON.stringify(sql)})`)
    await sleep(150)
    await page.clickByText('Visualize')
    await page.waitFor(`window.__sqlviz.getTrace().sessionId > ${before}`, { label: `session ${sql.slice(0, 30)}` })
    // Node ids are structural, so two shape-identical queries share them.
    // Wait for the loaded trace to be the requested statement instead.
    await page.waitFor(
      `(() => {
        const state = window.__sqlviz.getTrace()
        if (state.trace !== null) {
          const normalize = (value) => String(value).replace(/\\s+/g, ' ').replace(/;\\s*$/, '').trim().toLowerCase()
          if (normalize(state.trace.query) === ${JSON.stringify(normalizeSql(sql))}) return true
        }
        const ids = [...document.querySelectorAll('[data-node-id]')].map((el) => el.getAttribute('data-node-id')).join('|')
        return ids.length > 0 && ids !== ${JSON.stringify(idsBefore)}
      })()`,
      { label: 'new graph' },
    )
    // The workspace chunk and the visualization store now load on demand,
    // so the canvas can legitimately still be a skeleton after the trace
    // exists. Wait for the real surface before measuring.
    await page.waitFor(
      `Boolean(document.querySelector('[role="application"]')) && document.querySelectorAll('[data-node-id]').length > 0`,
      { label: 'canvas surface', timeout: 60_000 },
    )
    await sleep(500)
  }

  const measure = async () =>
    page.evaluate(`(() => {
      const surface = document.querySelector('[role="application"]')
      const rect = surface.getBoundingClientRect()
      const inner = surface.firstElementChild
      const raw = getComputedStyle(inner).transform
      const m = /matrix\\(([^)]+)\\)/.exec(raw)
      const parts = m === null ? [1, 0, 0, 1, 0, 0] : m[1].split(',').map(Number)
      const label = document.querySelector('[aria-label="Zoom in"]')?.previousElementSibling?.textContent ?? ''
      const nodes = [...document.querySelectorAll('[data-node-id]')].map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-node-id'),
          kind: el.getAttribute('data-kind'),
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          width: r.width, height: r.height,
        }
      })
      return {
        zoom: parts[0], zoomLabel: label.trim(), panX: parts[4], panY: parts[5],
        canvas: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        nodes,
      }
    })()`)

  const outside = (state, axis) => {
    const tolerance = 2
    return state.nodes.filter((node) =>
      axis === 'x'
        ? node.right > state.canvas.right + tolerance || node.left < state.canvas.left - tolerance
        : node.bottom > state.canvas.bottom + tolerance || node.top < state.canvas.top - tolerance,
    )
  }

  const overlaps = (state) => {
    const pairs = []
    for (let i = 0; i < state.nodes.length; i += 1) {
      for (let j = i + 1; j < state.nodes.length; j += 1) {
        const a = state.nodes[i]
        const b = state.nodes[j]
        const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (dx > 2 && dy > 2) pairs.push(`${a.id} × ${b.id}`)
      }
    }
    return pairs
  }

  for (const testCase of CASES) {
    await visualize(testCase.sql)
    const fresh = await measure()
    check(
      `${testCase.name}: initial camera keeps every node horizontally visible`,
      outside(fresh, 'x').length === 0,
      outside(fresh, 'x').map((node) => node.id).join(', '),
    )
    if (fresh.zoom < 0.999) {
      const clippedVertically = outside(fresh, 'y')
      const topMost = Math.min(...fresh.nodes.map((node) => node.top))
      const topAnchored = topMost >= fresh.canvas.top - 2 && topMost <= fresh.canvas.top + 80
      check(
        `${testCase.name}: initial camera fits vertically, or is top-anchored for a long pipeline`,
        clippedVertically.length === 0 || topAnchored,
        clippedVertically.length === 0
          ? ''
          : `top-anchored=${topAnchored} clipped=${clippedVertically.map((node) => node.id).join(', ')}`,
      )
    }

    await page.click('[aria-label="Jump to final result"]')
    await sleep(500)
    await page.click('[aria-label="Fit to screen"]')
    await sleep(500)
    const fitted = await measure()
    check(
      `${testCase.name}: fit-to-screen includes every node`,
      outside(fitted, 'x').length === 0 && outside(fitted, 'y').length === 0,
      [...outside(fitted, 'x'), ...outside(fitted, 'y')].map((node) => node.id).join(', '),
    )
    check(`${testCase.name}: no overlapping nodes at fit zoom`, overlaps(fitted).length === 0, overlaps(fitted).join('; '))
    const finalNode = fitted.nodes.find((node) => node.kind === 'final')
    check(
      `${testCase.name}: final node is visible at fit zoom`,
      finalNode !== undefined &&
        finalNode.bottom <= fitted.canvas.bottom + 2 &&
        finalNode.right <= fitted.canvas.right + 2,
    )

    await page.click('[aria-label="Reset view"]')
    await sleep(400)
    const reset = await measure()
    check(
      `${testCase.name}: reset view keeps every node horizontally visible`,
      outside(reset, 'x').length === 0,
      outside(reset, 'x').map((node) => node.id).join(', '),
    )
    await page.screenshot(`stage9-${testCase.name}.png`)
  }

  // --- Navigation stability -------------------------------------------------
  await visualize(CASES[1].sql)
  await page.click('[aria-label="Fit to screen"]')
  await sleep(400)

  const beforeZoom = await measure()
  const point = {
    x: beforeZoom.canvas.left + 80,
    y: beforeZoom.canvas.top + 90,
  }
  const anchorNode = beforeZoom.nodes.find((node) => node.kind === 'operation')
  const anchorBefore = { x: (anchorNode.left + anchorNode.right) / 2, y: (anchorNode.top + anchorNode.bottom) / 2 }
  for (let step = 0; step < 3; step += 1) {
    await page.wheel(point.x, point.y, -120)
    await sleep(90)
  }
  await sleep(300)
  const afterZoom = await measure()
  const anchorAfterNode = afterZoom.nodes.find((node) => node.id === anchorNode.id)
  const anchorAfter = { x: (anchorAfterNode.left + anchorAfterNode.right) / 2, y: (anchorAfterNode.top + anchorAfterNode.bottom) / 2 }
  check('pointer-centred zoom increases the scale', afterZoom.zoom > beforeZoom.zoom + 0.05, `${beforeZoom.zoomLabel} → ${afterZoom.zoomLabel}`)
  check(
    'pointer-centred zoom keeps the anchor under the cursor',
    Math.abs((anchorAfter.x - point.x) / (anchorBefore.x - point.x) - afterZoom.zoom / beforeZoom.zoom) < 0.15,
  )

  const zoomBeforePlayback = afterZoom.zoom
  for (let step = 0; step < 4; step += 1) {
    await page.click('[aria-label="Next event"]')
    await sleep(120)
  }
  const afterPlayback = await measure()
  check('playback does not reset manual zoom', Math.abs(afterPlayback.zoom - zoomBeforePlayback) < 0.001, `${zoomBeforePlayback} → ${afterPlayback.zoom}`)

  // Zoom anchoring near the canvas edges (not just the centre).
  for (const [label, edge] of [
    ['top-left', { x: 4, y: 4 }],
    ['bottom-right', { x: -6, y: -6 }],
  ]) {
    const point = {
      x: edge.x >= 0 ? afterPlayback.canvas.left + edge.x : afterPlayback.canvas.right + edge.x,
      y: edge.y >= 0 ? afterPlayback.canvas.top + edge.y : afterPlayback.canvas.bottom + edge.y,
    }
    const before = await measure()
    const graphPoint = {
      x: (point.x - before.canvas.left - before.panX) / before.zoom,
      y: (point.y - before.canvas.top - before.panY) / before.zoom,
    }
    await page.wheel(point.x, point.y, -120)
    await sleep(250)
    const after = await measure()
    const afterGraphPoint = {
      x: (point.x - after.canvas.left - after.panX) / after.zoom,
      y: (point.y - after.canvas.top - after.panY) / after.zoom,
    }
    check(
      `zoom near the ${label} edge keeps the anchored point stationary`,
      Math.abs(afterGraphPoint.x - graphPoint.x) < 0.5 && Math.abs(afterGraphPoint.y - graphPoint.y) < 0.5,
      `Δ(${(afterGraphPoint.x - graphPoint.x).toFixed(2)}, ${(afterGraphPoint.y - graphPoint.y).toFixed(2)})`,
    )
  }

  // Wheel navigation must not fight a node drag.
  const dragState = await measure()
  const dragNode = dragState.nodes.find((node) => node.kind === 'operation')
  const dragFrom = {
    x: (dragNode.left + dragNode.right) / 2,
    y: (dragNode.top + dragNode.bottom) / 2,
  }
  await page.connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: dragFrom.x, y: dragFrom.y, buttons: 0 },
    page.sessionId,
  )
  await page.connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: dragFrom.x, y: dragFrom.y, button: 'left', buttons: 1, clickCount: 1 },
    page.sessionId,
  )
  await page.connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: dragFrom.x + 40, y: dragFrom.y + 30, button: 'left', buttons: 1 },
    page.sessionId,
  )
  const zoomDuringDrag = (await measure()).zoom
  await page.wheel(dragFrom.x + 90, dragFrom.y + 70, -120)
  await sleep(200)
  const zoomAfterWheelInDrag = (await measure()).zoom
  await page.connection.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: dragFrom.x + 40, y: dragFrom.y + 30, button: 'left', buttons: 0, clickCount: 1 },
    page.sessionId,
  )
  await sleep(200)
  check(
    'wheel during a node drag does not zoom the canvas',
    Math.abs(zoomAfterWheelInDrag - zoomDuringDrag) < 0.001,
    `${zoomDuringDrag} → ${zoomAfterWheelInDrag}`,
  )

  // Pan at the current zoom moves only the camera, never node coordinates.
  const panZoomState = await measure()
  const panFrom = {
    x: panZoomState.canvas.left + 40,
    y: panZoomState.canvas.top + 40,
  }
  const panNode = panZoomState.nodes.find((node) => node.kind === 'operation')
  const nodeGraphBefore = {
    x: (panNode.left - panZoomState.canvas.left - panZoomState.panX) / panZoomState.zoom,
    y: (panNode.top - panZoomState.canvas.top - panZoomState.panY) / panZoomState.zoom,
  }
  await page.drag(panFrom, { x: panFrom.x + 90, y: panFrom.y + 60 })
  await sleep(250)
  const panZoomAfter = await measure()
  const panNodeAfter = panZoomAfter.nodes.find((node) => node.id === panNode.id)
  const nodeGraphAfter = {
    x: (panNodeAfter.left - panZoomAfter.canvas.left - panZoomAfter.panX) / panZoomAfter.zoom,
    y: (panNodeAfter.top - panZoomAfter.canvas.top - panZoomAfter.panY) / panZoomAfter.zoom,
  }
  check(
    'panning at a non-default zoom moves the camera by the pointer delta',
    Math.abs(panZoomAfter.panX - panZoomState.panX - 90) < 2 &&
      Math.abs(panZoomAfter.panY - panZoomState.panY - 60) < 2,
    `Δ(${Math.round(panZoomAfter.panX - panZoomState.panX)}, ${Math.round(panZoomAfter.panY - panZoomState.panY)})`,
  )
  check(
    'panning never changes node graph coordinates',
    Math.abs(nodeGraphAfter.x - nodeGraphBefore.x) < 1.5 && Math.abs(nodeGraphAfter.y - nodeGraphBefore.y) < 1.5,
    `Δ(${(nodeGraphAfter.x - nodeGraphBefore.x).toFixed(2)}, ${(nodeGraphAfter.y - nodeGraphBefore.y).toFixed(2)})`,
  )
  await page.screenshot('stage9-manual-zoom-pan.png')

  const manualBeforeResize = await measure()
  await page.connection.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false },
    page.sessionId,
  )
  await sleep(500)
  const afterResize = await measure()
  check(
    'resize preserves manual navigation',
    Math.abs(afterResize.panX - manualBeforeResize.panX) < 1 && Math.abs(afterResize.zoom - manualBeforeResize.zoom) < 0.001,
    `pan ${Math.round(afterResize.panX)} vs ${Math.round(manualBeforeResize.panX)}`,
  )

  // After an emulated resize the pointer coordinates can lag the new layout,
  // so invoke the same toolbar handler through the DOM element.
  await page.evaluate(`document.querySelector('[aria-label="Fit to screen"]').click()`)
  await sleep(400)
  const fitSmall = await measure()
  check(
    'manual fit works after a resize',
    outside(fitSmall, 'x').length === 0 && outside(fitSmall, 'y').length === 0,
    `zoom=${fitSmall.zoomLabel} canvas=${Math.round(fitSmall.canvas.right - fitSmall.canvas.left)}x${Math.round(fitSmall.canvas.bottom - fitSmall.canvas.top)} outside=${[...outside(fitSmall, 'x'), ...outside(fitSmall, 'y')].map((node) => node.id).join(', ')}`,
  )

  await page.connection.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1460, height: 900, deviceScaleFactor: 1, mobile: false },
    page.sessionId,
  )
  await sleep(600)
  const refit = await measure()
  check(
    'automatic fit re-applies after a resize',
    outside(refit, 'x').length === 0 && outside(refit, 'y').length === 0,
    `zoom=${refit.zoomLabel} canvas=${Math.round(refit.canvas.right - refit.canvas.left)}x${Math.round(refit.canvas.bottom - refit.canvas.top)} outside=${[...outside(refit, 'x'), ...outside(refit, 'y')].map((node) => node.id).join(', ')}`,
  )
  await page.screenshot('stage9-after-resize.png')

  consoleErrors.push(...page.consoleMessages.filter((message) => message.type === 'error').map((message) => message.text))
  check('no console errors during canvas UX checks', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // Stage 9C: the rendered copy must explain empty results rather than
  // leaving a bare "no rows" box.
  await visualize(CASES.find((testCase) => testCase.name === 'empty').sql)
  await page.click('[aria-label="Jump to final result"]')
  await sleep(500)
  const emptyCopy = await page.evaluate(`(() => {
    const finalNode = document.querySelector('[data-node-id="final"]')
    return {
      text: finalNode?.innerText ?? '',
      title: finalNode?.querySelector('.flow-empty')?.getAttribute('title') ?? '',
    }
  })()`)
  check(
    'empty result node explains that no rows were returned',
    emptyCopy.text.includes('no rows returned'),
    emptyCopy.text.slice(0, 80).replace(/\n/g, ' '),
  )
  await page.screenshot('stage9-empty-result.png')
  page.close()
} finally {
  await browser.close()
  if (server !== null) {
    spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
}

const failed = results.filter((record) => !record.ok)
await writeFile(join(OUT, 'report.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
console.log(`\nRESULT ${results.length - failed.length}/${results.length} canvas UX checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
