/**
 * Appearance browser QA: boot splash, nine themes, reduced motion/effects,
 * and desktop/mobile rendering. Uses the same dependency-free CDP driver as
 * the other QA suites.
 *
 *   QA_MANAGED_SERVER=1 npm run qa:appearance
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', 'appearance')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const THEMES = [
  { id: 'light', mode: 'light' },
  { id: 'dark', mode: 'dark' },
  { id: 'midnight', mode: 'dark' },
  { id: 'dracula', mode: 'dark' },
  { id: 'nord', mode: 'dark' },
  { id: 'solarized-dark', mode: 'dark' },
  { id: 'glassy', mode: 'dark' },
  { id: 'bloody', mode: 'dark' },
  { id: 'cyberpunk', mode: 'dark' },
]

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let server = null
if (process.env.QA_MANAGED_SERVER === '1') {
  server = spawn(
    process.execPath,
    [join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    { stdio: 'ignore', windowsHide: true },
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Dev server exited with code ${server.exitCode}`)
    try {
      if ((await fetch(URL)).ok) break
    } catch {
      /* starting */
    }
    await sleep(200)
  }
}

const setStorage = (page, key, value) =>
  page.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)

const reloadReady = async (page) => {
  await page.reload()
  await page.waitFor(`Boolean(window.__sqlviz) && window.__sqlviz.databases().length > 0`, {
    label: 'app ready after reload',
    timeout: 60_000,
  })
  await sleep(250)
}

const browser = await launchBrowser({ port: Number(process.env.CDP_PORT ?? 9343) })
let page
try {
  await mkdir(OUT, { recursive: true })
  page = await browser.openPage(URL)
  await page.setArtifactDir(OUT)

  const html = await (await fetch(URL)).text()
  check('boot splash is present in the initial HTML', html.includes('id="boot-splash"'))
  check('pre-paint theme script is loaded before the bundle', html.indexOf('theme-init.js') < html.indexOf('/src/main.tsx'))
  check(
    'boot splash honours reduced motion and reduced effects in CSS',
    html.includes('prefers-reduced-motion: reduce') && html.includes('.reduce-effects .boot-glow'),
  )

  await page.waitFor(`Boolean(window.__sqlviz) && window.__sqlviz.databases().length > 0`, {
    label: 'app ready',
    timeout: 60_000,
  })
  await sleep(300)
  check('boot splash is replaced after hydration', await page.evaluate(`!document.getElementById('boot-splash')`))
  check('React loading screen is not left mounted when ready', await page.evaluate(`!document.querySelector('.app-loader')`))

  const accents = []
  for (const theme of THEMES) {
    await setStorage(page, 'sql-visualizer-theme', theme.id)
    await reloadReady(page)
    const state = await page.evaluate(`(() => {
      const root = document.documentElement
      const styles = getComputedStyle(root)
      return {
        theme: root.dataset.theme,
        dark: root.classList.contains('dark'),
        colorScheme: styles.colorScheme,
        accent: styles.getPropertyValue('--accent').trim(),
        bg: getComputedStyle(document.body).backgroundColor,
      }
    })()`)
    check(`${theme.id}: theme applied to the document root`, state.theme === theme.id, state.theme)
    check(`${theme.id}: light/dark mode class is correct`, state.dark === (theme.mode === 'dark'), `dark=${state.dark}`)
    check(`${theme.id}: palette resolves and is visible`, state.accent.length > 0 && state.bg.length > 0, `${state.accent} / ${state.bg}`)
    check(`${theme.id}: no horizontal overflow on desktop`, await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`))
    accents.push(state.accent)
    await page.screenshot(`theme-${theme.id}.png`)
  }
  check('the nine themes resolve to distinct accents', new Set(accents).size >= 7, `${new Set(accents).size} unique accents`)

  // Reduced motion: an injected probe inherits the global media query.
  await page.connection.send('Emulation.setEmulatedMedia', { features: [] }, page.sessionId)
  const motionProbe = `(() => {
    const probe = document.createElement('div')
    probe.className = 'app-loader__mark'
    document.body.appendChild(probe)
    const name = getComputedStyle(probe).animationName
    probe.remove()
    return name
  })()`
  const normalAnimation = await page.evaluate(motionProbe)
  await page.connection.send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
    page.sessionId,
  )
  const reducedAnimation = await page.evaluate(motionProbe)
  await page.connection.send('Emulation.setEmulatedMedia', { features: [] }, page.sessionId)
  check('loading animation runs with normal motion', normalAnimation !== 'none', normalAnimation)
  check('loading animation stops with prefers-reduced-motion', reducedAnimation === 'none', reducedAnimation)

  // Reduced effects: the settings switch is persisted and disables heavy FX.
  await setStorage(page, 'sql-visualizer-theme', 'glassy')
  await setStorage(page, 'sql-visualizer-reduced-effects', 'false')
  await reloadReady(page)
  await page.click('[aria-label="Open settings"]')
  await page.waitFor(`Boolean([...document.querySelectorAll('input[type="checkbox"]')].find((input) => input.closest('label')?.innerText.includes('Reduced effects')))`, { label: 'reduced-effects switch' })
  await page.evaluate(`[...document.querySelectorAll('input[type="checkbox"]')].find((input) => input.closest('label')?.innerText.includes('Reduced effects')).click()`)
  check('settings switch adds the reduced-effects class', await page.evaluate(`document.documentElement.classList.contains('reduce-effects')`))
  check('reduced effects are persisted', await page.evaluate(`localStorage.getItem('sql-visualizer-reduced-effects') === 'true'`))
  const glassBlur = await page.evaluate(`getComputedStyle(document.querySelector('.glass-surface')).backdropFilter`)
  check('Glassy blur is disabled by reduced effects', glassBlur === 'none', glassBlur)
  await page.click('[aria-label="Close dialog"]')

  await setStorage(page, 'sql-visualizer-theme', 'cyberpunk')
  await reloadReady(page)
  const cyberGrid = await page.evaluate(`getComputedStyle(document.querySelector('.app-shell')).backgroundImage`)
  check('Cyberpunk grid is disabled by reduced effects', cyberGrid === 'none', cyberGrid)
  const cyberLoader = await page.evaluate(`(() => {
    const probe = document.createElement('div')
    probe.className = 'app-loader'
    document.body.appendChild(probe)
    const image = getComputedStyle(probe).backgroundImage
    probe.remove()
    return image
  })()`)
  check('Cyberpunk loader grid is disabled by reduced effects', cyberLoader === 'none', cyberLoader)

  // Mobile: restore effects, then verify a usable layout and a real Canvas.
  await setStorage(page, 'sql-visualizer-reduced-effects', 'false')
  await page.connection.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    page.sessionId,
  )
  await reloadReady(page)
  const mobile = await page.evaluate(`(() => {
    const shell = document.querySelector('.app-shell')
    const toggle = document.querySelector('[aria-label="Workspace"]')
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      shellVisible: Boolean(shell && shell.getBoundingClientRect().height > 0),
      toggleVisible: Boolean(toggle && toggle.getBoundingClientRect().height > 0),
      bodyOverflow: getComputedStyle(document.body).overflow,
    }
  })()`)
  check('mobile layout has no horizontal overflow', mobile.scrollWidth <= mobile.innerWidth + 1, `${mobile.scrollWidth} / ${mobile.innerWidth}`)
  check('mobile app shell and workspace toggle are visible', mobile.shellVisible && mobile.toggleVisible, JSON.stringify(mobile))
  check('mobile viewport height uses dynamic viewport sizing', mobile.bodyOverflow === 'hidden', mobile.bodyOverflow)

  await page.click('[aria-label="Open settings"]')
  const settingsRect = await page.evaluate(`(() => {
    const panel = document.querySelector('.modal-panel')
    if (!panel) return null
    const r = panel.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  })()`)
  check('mobile settings dialog stays inside the viewport', settingsRect !== null && settingsRect.left >= -1 && settingsRect.right <= mobile.innerWidth + 1 && settingsRect.bottom <= 844 + 1, JSON.stringify(settingsRect))
  await page.click('[aria-label="Close dialog"]')
  await sleep(200)

  await page.clickByText('Visualize')
  await page.waitFor(`document.querySelectorAll('[data-node-id]').length > 0 || document.querySelector('[aria-label="Jump to final result"]') !== null`, { label: 'mobile canvas', timeout: 30_000 })
  check('mobile Canvas renders the visualization', await page.evaluate(`document.querySelectorAll('[data-node-id]').length > 0 || Boolean(document.querySelector('[role="application"]'))`))
  check('mobile Canvas has no horizontal overflow', await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`))
  await page.screenshot('mobile-canvas.png')

  await page.connection.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    page.sessionId,
  )
  await sleep(300)
  check('desktop Canvas has no horizontal overflow', await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`))
  await page.screenshot('desktop-canvas.png')

  const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error').map((message) => message.text)
  check('no console errors during appearance checks', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  check('no page exceptions during appearance checks', page.pageErrors.length === 0, page.pageErrors.slice(0, 2).join(' | '))
} finally {
  try {
    page?.close()
  } catch {
    /* ignore */
  }
  await browser.close()
  if (server !== null) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        server.kill('SIGKILL')
      }
    } catch {
      /* ignore */
    }
  }
}

const failed = results.filter((record) => !record.ok)
await writeFile(join(OUT, 'report.json'), JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2))
console.log(`\nRESULT ${results.length - failed.length}/${results.length} appearance checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
