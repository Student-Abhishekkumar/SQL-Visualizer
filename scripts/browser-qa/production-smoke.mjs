/**
 * Production-build smoke test: no dev bridge, only real user actions.
 * Verifies the built bundle loads, renders, and produces a Canvas graph.
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:4173/'
const PORT = Number(process.env.CDP_PORT ?? 9339)
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', 'production-smoke')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let preview = null
if (process.env.QA_MANAGED_PREVIEW === '1') {
  preview = spawn(
    process.execPath,
    [join('node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    { stdio: 'ignore', windowsHide: true },
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(URL)
      if (response.ok) break
    } catch {
      /* starting */
    }
    await sleep(200)
  }
}

const browser = await launchBrowser({ port: PORT })
const consoleErrors = []
const pageErrors = []
let page
try {
  await mkdir(OUT, { recursive: true })
  const started = Date.now()
  page = await browser.openPage(URL)
  await page.setArtifactDir(OUT)
  await page.waitFor(`document.querySelectorAll('.monaco-editor').length > 0`, { label: 'editor mounted', timeout: 60_000 })
  await page.waitFor(
    `(() => {
      const text = (document.body.innerText ?? '').toLowerCase()
      return text.includes('employees') && text.includes('sqlite wasm')
    })()`,
    { label: 'database connected', timeout: 60_000 },
  )
  const readyMs = Date.now() - started
  console.log(`READY_MS ${readyMs}`)

  const bridgeAbsent = await page.evaluate(`typeof window.__sqlviz === 'undefined'`)
  check('dev bridge is tree-shaken from the production bundle', bridgeAbsent === true)

  const defaultQuery = await page.evaluate(`document.querySelector('.monaco-editor')?.innerText?.slice(0, 120) ?? ''`)
  check('editor renders the default query', defaultQuery.length > 0, JSON.stringify(defaultQuery.slice(0, 60)))

  await page.clickByText('Visualize')
  await page.waitFor(`document.querySelectorAll('[data-node-id]').length > 0`, { label: 'production canvas', timeout: 30_000 })
  await sleep(400)
  const snapshot = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('[data-node-id]')].map((element) => ({
      id: element.getAttribute('data-node-id'),
      kind: element.getAttribute('data-kind'),
      stage: element.getAttribute('data-stage'),
      label: (element.querySelector('.flow-node-title')?.textContent ?? '').trim(),
    }))
    return {
      nodes,
      edges: document.querySelectorAll('.flow-edge').length,
      finals: nodes.filter((node) => node.kind === 'final').length,
      unique: new Set(nodes.map((node) => node.id)).size,
    }
  })()`)
  check('production Canvas renders nodes', snapshot.nodes.length > 0, `${snapshot.nodes.length} nodes`)
  check('production Canvas renders wires', snapshot.edges > 0, `${snapshot.edges} edges`)
  check('production Canvas has one final node', snapshot.finals === 1)
  check('production node ids are unique', snapshot.unique === snapshot.nodes.length)
  check(
    'production graph shows the default GROUP BY query',
    snapshot.nodes.some((node) => node.stage === 'GROUP_BY') && snapshot.nodes.some((node) => node.stage === 'SELECT'),
    snapshot.nodes.map((node) => `${node.id}:${node.stage ?? node.kind}`).join(', '),
  )

  await page.click('[aria-label="Jump to final result"]')
  await sleep(500)
  const finalStatus = await page.evaluate(
    `document.querySelector('[data-node-id="final"]')?.getAttribute('data-status') ?? null`,
  )
  check('production playback completes the final node', finalStatus === 'completed', `${finalStatus}`)

  const metrics = await page.evaluate(`(() => {
    const resources = performance.getEntriesByType('resource').filter((entry) => entry.name.endsWith('.js'))
    return {
      jsTransferBytes: resources.reduce((total, entry) => total + (entry.transferSize || 0), 0),
      jsDecodedBytes: resources.reduce((total, entry) => total + (entry.decodedBodySize || 0), 0),
      scriptCount: resources.length,
      domContentLoaded: Math.round(performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd ?? 0),
      loadEvent: Math.round(performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? 0),
    }
  })()`)
  console.log('METRICS', JSON.stringify(metrics))

  consoleErrors.push(...page.consoleMessages.filter((message) => message.type === 'error').map((message) => message.text))
  pageErrors.push(...page.pageErrors)
  check('no console errors in production', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  check('no page exceptions in production', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  await page.screenshot('production-canvas.png')
} finally {
  try {
    page?.close()
  } catch {
    /* ignore */
  }
  await browser.close()
  if (preview !== null) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        preview.kill('SIGKILL')
      }
    } catch {
      /* ignore */
    }
  }
}

const failed = results.filter((record) => !record.ok)
console.log(`\nRESULT ${results.length - failed.length}/${results.length} production checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
