/** Real-browser UI/UX audit: all target viewports, workflows and touch gestures. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/#/app'
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', 'ui-ux')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
let server = null
if (process.env.QA_MANAGED_SERVER === '1') {
  server = spawn(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { stdio: 'ignore', windowsHide: true })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Dev server exited with code ${server.exitCode}`)
    try { if ((await fetch(URL)).ok) break } catch { /* starting */ }
    await sleep(200)
  }
}
const viewports = [
  [320, 568], [360, 800], [375, 667], [390, 844], [430, 932], [768, 1024],
  [1024, 768], [1280, 800], [1440, 900], [1920, 1080],
]
const defaultQuery = 'SELECT department_id, COUNT(*) AS employees\nFROM employees\nGROUP BY department_id\nORDER BY employees DESC;'
const browser = await launchBrowser({ port: Number(process.env.CDP_PORT ?? 9351) })
let page
async function viewport(width, height, mobile = false, scale = 1) {
  await page.connection.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile }, page.sessionId)
  await sleep(180)
}
async function touch(points, type = 'touchStart') {
  await page.connection.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((point, index) => ({ ...point, id: index })),
  }, page.sessionId)
}
async function tap(point) {
  await touch([point])
  await touch([], 'touchEnd')
  await sleep(120)
}
try {
  await mkdir(OUT, { recursive: true })
  page = await browser.openPage(URL)
  await page.setArtifactDir(OUT)
  await page.waitFor(`Boolean(window.__sqlviz) && window.__sqlviz.databases().length > 0 && document.querySelector('.monaco-editor')`, { label: 'fully loaded application', timeout: 60_000 })
  for (const [width, height] of viewports) {
    await viewport(width, height, width < 768)
    await page.evaluate(`window.__sqlviz.setView('query')`)
    await sleep(120)
    const layout = await page.evaluate(`(() => {
      const controls = [...document.querySelectorAll('#app-navbar button, [aria-label="Query actions"] button')]
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => {
          const r = element.getBoundingClientRect()
          return { label: element.textContent?.trim() || element.getAttribute('aria-label'), left: r.left, right: r.right, width: r.width, height: r.height }
        })
      return { innerWidth, scrollWidth: document.documentElement.scrollWidth, controls }
    })()`)
    check(`${width}x${height}: no horizontal page overflow`, layout.scrollWidth <= width + 1, `${layout.scrollWidth}/${width}`)
    check(`${width}x${height}: navigation and query controls stay on screen`, layout.controls.every((control) => control.left >= -1 && control.right <= width + 1), layout.controls.filter((control) => control.left < -1 || control.right > width + 1))
    await page.screenshot(`query-${width}x${height}.png`)
  }
  await viewport(1440, 900)
  await page.clickByText('Examples')
  await page.waitFor(`Boolean(document.querySelector('[role="listbox"][aria-label="Example queries"]'))`)
  await page.screenshot('examples-desktop.png')
  await page.key('Escape', 'Escape', 27)
  check('Examples closes with Escape and restores trigger focus', await page.evaluate(`!document.querySelector('[role="listbox"][aria-label="Example queries"]') && document.activeElement?.textContent?.includes('Examples')`))
  if (await page.evaluate(`Boolean(document.querySelector('[role="listbox"][aria-label="Example queries"]'))`)) await page.clickByText('Examples')
  await page.clickByText('Examples')
  await page.click('[role="option"]')
  const loadedExample = await page.evaluate(`window.__sqlviz.getEditor()`)
  check('Examples loads executable SQL into the real editor', loadedExample.trim().length > 0 && loadedExample !== defaultQuery)
  await page.clickByText('Run')
  await page.waitFor(`document.querySelectorAll('tbody tr').length > 0`, { label: 'real query results' })
  check('Example query renders real SQLite rows', await page.evaluate(`document.querySelectorAll('tbody tr').length > 0`))
  await page.screenshot('results-desktop.png')
  await page.evaluate(`(async () => { window.__sqlviz.setEditor('SELECT * FROM table_that_does_not_exist;'); await window.__sqlviz.run() })()`)
  await page.waitFor(`(document.body.innerText ?? '').includes('no such table')`, { label: 'SQLite error feedback' })
  check('SQLite errors appear in the results workflow', await page.evaluate(`document.querySelector('[role="tablist"][aria-label="Results views"] [role="tab"][aria-selected="true"]')?.textContent?.includes('Messages')`))
  await page.screenshot('query-error.png')
  await page.evaluate(`window.__sqlviz.setEditor(${JSON.stringify(defaultQuery)})`)
  await viewport(390, 844, true)
  await page.connection.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 }, page.sessionId)
  await page.clickByText('Visualize')
  await page.waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, { label: 'mobile canvas', timeout: 30_000 })
  await sleep(300)
  await page.screenshot('canvas-mobile-initial.png')
  const initialCamera = await page.evaluate(`(() => {
    const surface = document.querySelector('.flow-canvas')?.firstElementChild
    return { transform: surface?.style.transform ?? '', zoom: document.querySelector('[aria-label="Zoom out"]')?.nextElementSibling?.textContent ?? '' }
  })()`)
  check('mobile initial camera keeps nodes readable', Number.parseInt(initialCamera.zoom, 10) >= 50, initialCamera)
  const nodePoints = await page.evaluate(`(() => {
    const canvas = document.querySelector('.flow-canvas')
    if (!canvas) return []
    const bounds = canvas.getBoundingClientRect()
    return [...document.querySelectorAll('[data-node-id]')]
      .map((node) => {
        const r = node.getBoundingClientRect()
        return {
          id: node.getAttribute('data-node-id'),
          x: r.left + r.width / 2,
          y: r.top + Math.min(r.height / 2, 16),
          visible: r.left + r.width / 2 > bounds.left + 6 && r.left + r.width / 2 < bounds.right - 6 && r.top + Math.min(r.height / 2, 16) > bounds.top + 6 && r.top + Math.min(r.height / 2, 16) < bounds.bottom - 6,
        }
      })
      .filter((point) => point.visible)
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, 2)
  })()`)
  if (nodePoints.length >= 2) {
    await tap(nodePoints[0])
    check('touch tap selects a node', await page.evaluate(`document.querySelector('.flow-canvas')?.getAttribute('data-selected-node') === ${JSON.stringify(nodePoints[0].id)}`))
    await tap(nodePoints[1])
    check('touch tap changes selection to another node', await page.evaluate(`document.querySelector('.flow-canvas')?.getAttribute('data-selected-node') === ${JSON.stringify(nodePoints[1].id)}`))
    const empty = await page.evaluate(`(() => {
      const canvas = document.querySelector('.flow-canvas')
      if (!canvas) return null
      const r = canvas.getBoundingClientRect()
      for (let y = r.bottom - 16; y > r.top + 16; y -= 36) {
        for (let x = r.left + 16; x < r.right - 16; x += 36) {
          const element = document.elementFromPoint(x, y)
          if (element && !element.closest('.flow-node, .node-inspector, button, .docs-sidebar')) return { x, y }
        }
      }
      return null
    })()`)
    if (empty) {
      await tap(empty)
      check('touch tap on empty Canvas deselects', await page.evaluate(`document.querySelector('.flow-canvas')?.getAttribute('data-selected-node') === null`))
    } else check('touch tap on empty Canvas deselects', false, 'No empty point found')
  } else check('touch node selection fixtures available', false, nodePoints)
  const gesture = await page.evaluate(`(() => {
    const r = document.querySelector('.flow-canvas').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.7 }
  })()`)
  const transform = () => page.evaluate(`document.querySelector('.flow-canvas')?.firstElementChild?.style.transform ?? ''`)
  const beforePinch = await transform()
  const p1 = { x: gesture.x - 30, y: gesture.y }
  const p2 = { x: gesture.x + 30, y: gesture.y }
  await touch([p1, p2])
  await touch([{ ...p1, x: p1.x - 35 }, { ...p2, x: p2.x + 35 }], 'touchMove')
  await touch([], 'touchEnd')
  await sleep(150)
  const afterPinch = await transform()
  check('two-finger pinch changes zoom around the gesture centre', beforePinch !== afterPinch && afterPinch.includes('scale'), { beforePinch, afterPinch })
  const beforePan = await transform()
  await touch([p1, p2])
  await touch([{ x: p1.x + 35, y: p1.y + 24 }, { x: p2.x + 35, y: p2.y + 24 }], 'touchMove')
  await touch([], 'touchEnd')
  await sleep(150)
  const afterPan = await transform()
  check('two-finger drag pans the Canvas', beforePan !== afterPan, { beforePan, afterPan })
  check('Canvas disables native touch scrolling', await page.evaluate(`getComputedStyle(document.querySelector('.flow-canvas')).touchAction === 'none' && document.documentElement.scrollWidth <= innerWidth + 1`))
  await page.screenshot('canvas-mobile-after-gestures.png')
  await viewport(1440, 900)
  await page.screenshot('canvas-desktop.png')
  check('no browser page exceptions during UI audit', page.pageErrors.length === 0, page.pageErrors.slice(0, 3))
  check('no console errors during UI audit', page.consoleMessages.filter((message) => message.type === 'error').length === 0, page.consoleMessages.filter((message) => message.type === 'error').slice(0, 3))
} finally {
  try { page?.close() } catch { /* ignore */ }
  await browser.close()
  if (server !== null) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      else server.kill('SIGKILL')
    } catch { /* ignore */ }
  }
}
const failed = results.filter((record) => !record.ok)
await writeFile(join(OUT, 'report.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
console.log(`\nRESULT ${results.length - failed.length}/${results.length} UI/UX checks passed`)
console.log(`Artifacts: ${OUT}`)
process.exitCode = failed.length === 0 ? 0 : 1
