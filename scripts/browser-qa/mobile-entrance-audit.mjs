/**
 * Mobile entrance audit — captures the 3s website entrance at real phone
 * viewports and reports composition/overflow facts. Dev-only helper.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', 'mobile-entrance')
const viewports = [
  [320, 568, 2],
  [360, 800, 2],
  [375, 667, 2],
  [390, 844, 3],
  [430, 932, 3],
  [768, 1024, 2],
  [844, 390, 2],
  [1440, 900, 1],
]
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const browser = await launchBrowser({ port: Number(process.env.CDP_PORT ?? 9361), width: 1440, height: 900 })
let page
try {
  await mkdir(OUT, { recursive: true })
  page = await browser.openPage('about:blank')
  await page.setArtifactDir(OUT)
  await page.connection.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `try { sessionStorage.removeItem('sqlviz.website-entrance.seen.v1') } catch {}
        (() => {
          const nativeSetTimeout = window.setTimeout.bind(window)
          window.setTimeout = (fn, delay, ...args) =>
            delay === 2700 || delay === 3000 ? 0 : nativeSetTimeout(fn, delay, ...args)
        })()`,
    },
    page.sessionId,
  )
  let visit = 0
  for (const [width, height, dpr] of viewports) {
    visit += 1
    await page.connection.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: dpr, mobile: width < 1000 },
      page.sessionId,
    )
    await page.connection.send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: width < 1000, maxTouchPoints: 5 },
      page.sessionId,
    )
    void page.connection.send('Page.navigate', { url: `${URL}?qa=${visit}` }, page.sessionId)
    await page.waitFor(
      `location.search === '?qa=${visit}' && Boolean(document.querySelector('.website-entrance'))`,
      { label: 'entrance mounted', timeout: 30_000, interval: 20 },
    )
    const shots = []
    const frame = async (time) => {
      await page.evaluate(
        `document.getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = ${time} })`,
      )
      return page.screenshot(`entrance-${width}x${height}-${String(time).padStart(4, '0')}.png`)
    }
    for (const time of [900, 1600, 2300, 2550]) {
      shots.push(await frame(time))
    }
    const facts = await page.evaluate(`(() => {
      const root = document.querySelector('.website-entrance')
      const brand = document.querySelector('.entrance-brand')
      const nodes = [...document.querySelectorAll('.cl-node')].map((node) => {
        const r = node.getBoundingClientRect()
        return {
          title: node.querySelector('.cl-node__title')?.textContent,
          x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
        }
      })
      const br = brand?.getBoundingClientRect()
      const inside = (r) => r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
      return {
        mode: root?.getAttribute('data-mode'),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        scrollWidth: document.documentElement.scrollWidth,
        nodeCount: nodes.length,
        nodes,
        brand: br ? { x: br.x, y: br.y, width: br.width, height: br.height, right: br.right, bottom: br.bottom } : null,
        nodesOutside: nodes.filter((node) => !inside(node)).map((node) => node.title),
        brandOutside: br ? !inside(br) : null,
        entranceVisible: root ? getComputedStyle(root).visibility !== 'hidden' && getComputedStyle(root).opacity !== '0' : false,
        homeVisible: Boolean(document.querySelector('.home')),
      }
    })()`)
    console.log(`\n=== ${width}x${height}@${dpr} mode=${facts.mode} ===`)
    console.log(JSON.stringify(facts, null, 2))
    check(`${width}x${height}: no horizontal overflow`, facts.scrollWidth <= width + 1, `${facts.scrollWidth}/${width}`)
    check(`${width}x${height}: all entrance nodes inside viewport`, facts.nodesOutside.length === 0, facts.nodesOutside)
    check(`${width}x${height}: brand inside viewport`, facts.brandOutside === false)
    check(`${width}x${height}: nodes are readable (>= 150px wide)`, facts.nodes.every((node) => node.width >= 150), facts.nodes.map((node) => Math.round(node.width)))
    shots.push(await frame(2950))
    const after = await page.evaluate(`({
      entrance: Boolean(document.querySelector('.website-entrance')),
      homeVisible: Boolean(document.querySelector('.home')),
      scrollWidth: document.documentElement.scrollWidth,
      homeScrollHeight: document.querySelector('.home')?.scrollHeight ?? 0,
    })`)
    check(`${width}x${height}: homepage is mounted beneath the entrance`, after.homeVisible === true, after)
    await writeFile(join(OUT, `facts-${width}x${height}.json`), JSON.stringify({ facts, after, shots }, null, 2))
  }
} finally {
  try {
    page?.close()
  } catch {
    /* ignore */
  }
  await browser.close()
}
const failed = results.filter((record) => !record.ok)
await writeFile(join(OUT, 'report.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
console.log(`\nRESULT ${results.length - failed.length}/${results.length} entrance checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
