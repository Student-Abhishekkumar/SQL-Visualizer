/**
 * Real-time mobile journey audit.
 *
 * Unlike the frame-freezing entrance audit, this drives the actual three-second
 * timeline: entrance -> homepage -> theme switch -> CTA -> real workspace.
 * It measures the handoff, touch-target sizes, overflow, scroll locking and
 * console health at every target viewport.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBrowser } from './cdp.mjs'

const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const OUT = process.env.QA_OUT ?? join('artifacts', 'browser-qa', 'mobile-journey')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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

const browser = await launchBrowser({ port: Number(process.env.CDP_PORT ?? 9362), width: 1440, height: 900 })
let page
try {
  await mkdir(OUT, { recursive: true })
  page = await browser.openPage('about:blank')
  await page.setArtifactDir(OUT)

  // Every navigation starts a fresh entrance and records the real timeline
  // from inside the page (performance.now() resets per document).
  await page.connection.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `
        try { sessionStorage.clear() } catch {}
        window.__journey = {
          entranceAt: null,
          goneAt: null,
          homeAt: null,
          frames: 0,
          firstFrameAt: null,
          lastFrameAt: null,
        }
        const observe = () => {
          const entrance = document.querySelector('.website-entrance')
          const home = document.querySelector('.home')
          if (entrance && window.__journey.entranceAt === null) {
            window.__journey.entranceAt = performance.now()
            window.__journey.firstFrameAt = performance.now()
          }
          if (home && window.__journey.homeAt === null) window.__journey.homeAt = performance.now()
          if (!entrance && window.__journey.entranceAt !== null && window.__journey.goneAt === null) {
            window.__journey.goneAt = performance.now()
          }
        }
        new MutationObserver(observe).observe(document, { childList: true, subtree: true })
        document.addEventListener('DOMContentLoaded', observe, { once: true })
        observe()
        const frame = () => {
          if (document.querySelector('.website-entrance')) {
            window.__journey.frames += 1
            window.__journey.lastFrameAt = performance.now()
          }
          requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
      `,
    },
    page.sessionId,
  )

  // Warm the dev server and renderer before the first measured viewport. The
  // very first navigation compiles modules and loads fonts mid-entrance, which
  // otherwise shows up as false jank in the 320x568 frame-rate sample.
  {
    const [width, height, dpr] = viewports[0]
    await page.connection.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: dpr, mobile: true },
      page.sessionId,
    )
    await page.navigate(`${URL}?warmup=1`)
    await page.waitFor(`Boolean(document.querySelector('.website-entrance'))`, {
      label: 'warmup entrance',
      timeout: 15_000,
      interval: 20,
    })
    await page
      .waitFor(`!document.querySelector('.website-entrance')`, {
        label: 'warmup handoff',
        timeout: 8_000,
        interval: 50,
      })
      .catch(() => {})
  }

  let visit = 0
  for (const [width, height, dpr] of viewports) {
    visit += 1
    const mobile = width < 1000
    await page.connection.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: dpr, mobile },
      page.sessionId,
    )
    await page.connection.send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: mobile, maxTouchPoints: 5 },
      page.sessionId,
    )
    await page.navigate(`${URL}?journey=${visit}`)
    await page.waitFor(`Boolean(document.querySelector('.website-entrance'))`, {
      label: `${width}x${height} entrance`,
      timeout: 15_000,
      interval: 20,
    })

    // Measure the settled composition, not the 1.16x camera pull-back: the
    // entrance intentionally starts zoomed in (the same framing the app loader
    // uses), so sampling mid-zoom would report clipped cards that the user
    // never sees once the reveal finishes. The lens settles at ~1.4s; on a
    // throttled tab the animation clock can jump, so this is bounded well
    // before the 2.7s exit.
    await page
      .waitFor(
        `(() => {
          const lens = document.querySelector('.cl-lens')
          if (!lens) return true
          const t = getComputedStyle(lens).transform
          return t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)'
        })()`,
        { label: `${width}x${height} entrance settle`, timeout: 2400, interval: 25 },
      )
      .catch(() => {})
    // Hold until the wordmark has revealed too, so the measurement and the
    // saved frame show the real end state (the brand lands at ~2.45s, still
    // before the 2.7s exit). Bounded in case the animation clock is throttled.
    await page
      .waitFor(
        `(() => {
          const brand = document.querySelector('.entrance-brand')
          if (!brand) return true
          const opacity = parseFloat(getComputedStyle(brand).opacity)
          const started = window.__journey?.entranceAt ?? 0
          return opacity >= 0.99 || performance.now() - started > 2500
        })()`,
        { label: `${width}x${height} brand reveal`, timeout: 1600, interval: 30 },
      )
      .catch(() => {})
    await sleep(60)
    const during = await page.evaluate(`(() => {
      const entrance = document.querySelector('.website-entrance')
      const home = document.querySelector('.home')
      const hero = document.querySelector('.home-hero')
      const headline = document.querySelector('.home-headline')
      const cta = document.querySelector('.home-hero__content .home-btn--primary')
      const navCta = document.querySelector('.home-nav .home-btn--primary')
      const theme = document.querySelector('.home-nav .home-icon-btn')
      const box = (element) => {
        if (!element) return null
        const r = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
          display: style.display, visibility: style.visibility, opacity: style.opacity,
          fontSize: parseFloat(style.fontSize), text: (element.textContent ?? '').trim(),
        }
      }
      const entranceStyle = entrance ? getComputedStyle(entrance) : null
      return {
        entrance: box(entrance),
        entrancePosition: entranceStyle?.position,
        entranceOverflow: entranceStyle?.overflow,
        home: box(home),
        hero: box(hero),
        headline: box(headline),
        cta: box(cta),
        navCta: box(navCta),
        theme: box(theme),
        scrollWidth: document.documentElement.scrollWidth,
        scrollTop: document.querySelector('.home')?.scrollTop ?? 0,
        mode: entrance?.getAttribute('data-mode'),
        intro: home?.getAttribute('data-intro'),
        brand: box(document.querySelector('.entrance-brand')),
        nodes: [...document.querySelectorAll('.cl-node')].map((node) => box(node)),
      }
    })()`)

    check(`${width}x${height}: entrance is a fixed full-viewport layer`, during.entrancePosition === 'fixed' && during.entrance?.width >= width - 1 && during.entrance?.height >= height - 1, { position: during.entrancePosition, entrance: during.entrance })
    check(`${width}x${height}: homepage is mounted beneath the entrance`, Boolean(during.home && during.home.height > 0 && during.entrance), { home: during.home?.height, entrance: during.entrance?.height })
    check(`${width}x${height}: homepage landing animation is still at rest during the entrance`, during.intro === 'settled', during.intro)
    check(`${width}x${height}: no horizontal overflow during the entrance`, during.scrollWidth <= width + 1, `${during.scrollWidth}/${width}`)
    check(`${width}x${height}: entrance does not scroll the page`, during.scrollTop === 0, during.scrollTop)
    check(`${width}x${height}: entrance brand is inside the viewport`, Boolean(during.brand && during.brand.x >= -1 && during.brand.y >= -1 && during.brand.right <= width + 1 && during.brand.bottom <= height + 1), during.brand)
    check(`${width}x${height}: entrance nodes are inside the viewport`, during.nodes.every((node) => node && node.x >= -1 && node.y >= -1 && node.right <= width + 1 && node.bottom <= height + 1), during.nodes.map((node) => node && [Math.round(node.x), Math.round(node.y), Math.round(node.right), Math.round(node.bottom)]))
    if (mobile) {
      check(`${width}x${height}: hero CTA is a 44px touch target`, Boolean(during.cta && during.cta.height >= 44 && during.cta.width >= 160), during.cta)
      check(`${width}x${height}: nav CTA is a 44px touch target`, Boolean(during.navCta && during.navCta.height >= 44), during.navCta)
    }
    check(`${width}x${height}: headline stays inside the viewport and is readable`, Boolean(during.headline && during.headline.x >= -1 && during.headline.right <= width + 1 && during.headline.fontSize >= 24), during.headline)
    check(`${width}x${height}: hero CTA does not overlap the headline`, Boolean(during.cta && during.headline && during.cta.y >= during.headline.bottom - 1), { headlineBottom: during.headline?.bottom, ctaTop: during.cta?.y })
    await page.screenshot(`during-${width}x${height}.png`)

    await page.waitFor(`!document.querySelector('.website-entrance')`, {
      label: `${width}x${height} entrance handoff`,
      timeout: 8_000,
      interval: 20,
    })
    const timeline = await page.evaluate(`window.__journey`)
    const duration = timeline.goneAt - timeline.entranceAt
    const fps = timeline.lastFrameAt > timeline.firstFrameAt ? (timeline.frames * 1000) / (timeline.lastFrameAt - timeline.firstFrameAt) : 0
    check(`${width}x${height}: entrance hands off after the real 3s beat`, duration >= 2850 && duration <= 3400, `${Math.round(duration)}ms`)
    check(`${width}x${height}: homepage was already mounted at handoff`, timeline.homeAt !== null && timeline.homeAt <= timeline.entranceAt + 120, { entranceAt: Math.round(timeline.entranceAt), homeAt: Math.round(timeline.homeAt) })
    check(`${width}x${height}: entrance animation stays usable (>= 30 fps)`, fps >= 30, `${fps.toFixed(1)} fps`)

    const after = await page.evaluate(`(() => {
      const home = document.querySelector('.home')
      const headline = document.querySelector('.home-headline')
      const cta = document.querySelector('.home-hero__content .home-btn--primary')
      const box = (element) => {
        if (!element) return null
        const r = element.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      return {
        entrance: Boolean(document.querySelector('.website-entrance')),
        home: box(home),
        headline: box(headline),
        cta: box(cta),
        intro: home?.getAttribute('data-intro'),
        skipHidden: document.querySelector('.home-skip')?.hidden ?? true,
        headlineShift: (() => {
          const line = document.querySelector('#home-title .home-line > span')
          return line ? getComputedStyle(line).transform : null
        })(),
        eyebrowOpacity: (() => {
          const eyebrow = document.querySelector('.home-eyebrow')
          return eyebrow ? Number(getComputedStyle(eyebrow).opacity) : 1
        })(),
        scrollWidth: document.documentElement.scrollWidth,
        homeOverflowY: home ? getComputedStyle(home).overflowY : null,
        homeScrollHeight: home?.scrollHeight ?? 0,
        homeClientHeight: home?.clientHeight ?? 0,
      }
    })()`)
    check(`${width}x${height}: entrance is gone and the homepage is interactive`, after.entrance === false && Boolean(after.home && after.home.height > 0), after.entrance)
    // The landing choreography must be armed by the handoff itself: playing
    // right after the entrance leaves, and visibly short of its resting state.
    check(`${width}x${height}: homepage landing animation starts at the handoff`, after.intro === 'playing', after.intro)
    check(
      `${width}x${height}: hero is still mid-reveal when the entrance leaves`,
      after.headlineShift !== 'none' || after.eyebrowOpacity < 0.99,
      { shift: after.headlineShift, eyebrow: after.eyebrowOpacity },
    )
    const settleStarted = Date.now()
    await page.waitFor(
      `(() => {
        const home = document.querySelector('.home')
        const headline = document.querySelector('.home-headline')
        const skip = document.querySelector('.home-skip')
        const line = document.querySelector('#home-title .home-line > span')
        if (!home || !headline) return false
        const shift = line ? getComputedStyle(line).transform : 'none'
        return (home.getAttribute('data-intro') === 'settled' || skip?.hidden === true) && (shift === 'none' || shift === 'matrix(1, 0, 0, 1, 0, 0)')
      })()`,
      { label: `${width}x${height} homepage landing settles`, timeout: 6_000, interval: 40 },
    )
    const settleMs = Date.now() - settleStarted
    check(`${width}x${height}: homepage landing animation completes on its own`, settleMs < 4_000, `${settleMs}ms`)
    // The hero copy lands first; the faint background beats keep going for
    // about a second longer, so wait (bounded) for the page to declare itself
    // settled instead of sampling in the middle of the scene.
    const quietStarted = Date.now()
    await page.waitFor(
      `document.querySelector('.home')?.getAttribute('data-intro') === 'settled'`,
      { label: `${width}x${height} homepage reaches its settled state`, timeout: 4_000, interval: 40 },
    )
    const quietMs = Date.now() - quietStarted
    check(`${width}x${height}: homepage reaches its settled state on its own`, quietMs < 2_500, `${quietMs}ms`)
    const settled = await page.evaluate(`(() => {
      const home = document.querySelector('.home')
      const line = document.querySelector('#home-title .home-line > span')
      const cta = document.querySelector('.home-hero__content .home-btn--primary')
      const box = (element) => {
        if (!element) return null
        const r = element.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      return {
        intro: home?.getAttribute('data-intro'),
        skipHidden: document.querySelector('.home-skip')?.hidden ?? true,
        headlineShift: line ? getComputedStyle(line).transform : null,
        cta: box(cta),
      }
    })()`)
    check(`${width}x${height}: homepage settles without a skip-intro prompt`, settled.intro === 'settled' && settled.skipHidden === true, { intro: settled.intro, skipHidden: settled.skipHidden })
    check(`${width}x${height}: headline ends exactly at its resting position`, settled.headlineShift === 'none' || settled.headlineShift === 'matrix(1, 0, 0, 1, 0, 0)', settled.headlineShift)
    check(`${width}x${height}: no horizontal overflow after the handoff`, after.scrollWidth <= width + 1, `${after.scrollWidth}/${width}`)
    check(`${width}x${height}: homepage scrolls normally`, after.homeOverflowY !== 'hidden' && after.homeScrollHeight > after.homeClientHeight, { overflowY: after.homeOverflowY, scrollHeight: after.homeScrollHeight, clientHeight: after.homeClientHeight })
    check(`${width}x${height}: hero CTA is visible after the handoff`, Boolean(after.cta && after.cta.width >= 160 && after.cta.height >= 44 && after.cta.y >= 0 && after.cta.bottom <= height + 1), after.cta)
    await page.screenshot(`after-${width}x${height}.png`)

    // Theme switching is available where the header control fits.
    const themeControl = await page.evaluate(`(() => {
      const element = document.querySelector('.home-nav .home-icon-btn')
      if (!element) return null
      const r = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return { x: r.x, y: r.y, width: r.width, height: r.height, display: style.display, visibility: style.visibility }
    })()`)
    if (themeControl && themeControl.display !== 'none' && themeControl.visibility !== 'hidden' && themeControl.width > 0) {
      const beforeTheme = await page.evaluate(`document.documentElement.dataset.theme`)
      const themePoint = { x: themeControl.x + themeControl.width / 2, y: themeControl.y + themeControl.height / 2 }
      if (mobile) {
        await page.connection.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...themePoint, id: 0 }] }, page.sessionId)
        await page.connection.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page.sessionId)
      } else {
        await page.clickAt(themePoint.x, themePoint.y)
      }
      await sleep(300)
      const afterTheme = await page.evaluate(`document.documentElement.dataset.theme`)
      check(`${width}x${height}: theme control switches the palette`, beforeTheme !== afterTheme, { beforeTheme, afterTheme })
    }

    // Tap the real CTA and follow the launch beat into the workspace.
    const ctaPoint = { x: settled.cta.x + settled.cta.width / 2, y: settled.cta.y + settled.cta.height / 2 }
    const launchStarted = Date.now()
    if (mobile) {
      await page.connection.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...ctaPoint, id: 0 }] }, page.sessionId)
      await page.connection.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, page.sessionId)
    } else {
      await page.clickAt(ctaPoint.x, ctaPoint.y)
    }
    await page.waitFor(`location.hash === '#/app'`, { label: `${width}x${height} workspace route`, timeout: 8_000, interval: 20 })
    await page.waitFor(`Boolean(window.__sqlviz) && window.__sqlviz.databases().length > 0 && Boolean(document.querySelector('.monaco-editor'))`, {
      label: `${width}x${height} workspace ready`,
      timeout: 45_000,
      interval: 50,
    })
    const launchMs = Date.now() - launchStarted
    const workspace = await page.evaluate(`(() => {
      const editor = document.querySelector('.monaco-editor')
      const nav = document.querySelector('#app-navbar')
      const workspaceToggle = document.querySelector('[aria-label="Workspace"]')
      const rect = (element) => {
        if (!element) return null
        const r = element.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      return {
        hash: location.hash,
        editor: rect(editor),
        nav: rect(nav),
        workspaceToggle: rect(workspaceToggle),
        scrollWidth: document.documentElement.scrollWidth,
        bodyOverflow: getComputedStyle(document.body).overflow,
      }
    })()`)
    check(`${width}x${height}: CTA reaches the real workspace`, workspace.hash === '#/app' && Boolean(workspace.editor && workspace.editor.width > 0), workspace.hash)
    check(`${width}x${height}: workspace opens without a long delay`, launchMs < 8_000, `${launchMs}ms`)
    check(`${width}x${height}: workspace has no horizontal overflow`, workspace.scrollWidth <= width + 1, `${workspace.scrollWidth}/${width}`)
    if (mobile) {
      check(`${width}x${height}: mobile workspace navigation stays available`, Boolean(workspace.workspaceToggle && workspace.workspaceToggle.width > 0 && workspace.workspaceToggle.height >= 40), workspace.workspaceToggle)
    }
    await page.screenshot(`workspace-${width}x${height}.png`)

    // Back to the homepage for the next viewport; the injected script clears
    // session storage so the entrance plays again.
  }

  // Reduced motion: no entrance, immediate homepage.
  await page.connection.send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] },
    page.sessionId,
  )
  await page.connection.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    page.sessionId,
  )
  await page.navigate(`${URL}?journey=reduced`)
  await page.waitFor(`Boolean(document.querySelector('.home'))`, { label: 'reduced-motion homepage', timeout: 15_000 })
  await sleep(450)
  const reduced = await page.evaluate(`(() => {
    const home = document.querySelector('.home')
    return {
      entrance: Boolean(document.querySelector('.website-entrance')),
      intro: home?.getAttribute('data-intro'),
      headline: Boolean(document.querySelector('.home-headline')),
      scrollWidth: document.documentElement.scrollWidth,
    }
  })()`)
  check('reduced motion skips the entrance entirely', reduced.entrance === false && reduced.headline === true, reduced)
  check('reduced motion renders the homepage in its settled state', reduced.intro === 'settled', reduced.intro)
  check('reduced motion has no horizontal overflow', reduced.scrollWidth <= 391, reduced.scrollWidth)
  await page.screenshot('reduced-motion-home.png')
  await page.connection.send('Emulation.setEmulatedMedia', { features: [] }, page.sessionId)

  const consoleErrors = page.consoleMessages.filter((message) => message.type === 'error')
  check('no page exceptions during the mobile journey', page.pageErrors.length === 0, page.pageErrors.slice(0, 3))
  check('no console errors during the mobile journey', consoleErrors.length === 0, consoleErrors.slice(0, 3))
  check('no failed requests during the mobile journey', page.failedRequests.length === 0, page.failedRequests.slice(0, 3))
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
console.log(`\nRESULT ${results.length - failed.length}/${results.length} mobile journey checks passed`)
console.log(`Artifacts: ${OUT}`)
process.exitCode = failed.length === 0 ? 0 : 1