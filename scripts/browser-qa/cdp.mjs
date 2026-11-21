/**
 * Minimal Chrome DevTools Protocol driver for the browser QA suite.
 *
 * Uses only Node built-ins (global WebSocket, fetch, child_process), so the
 * repository gains no browser-automation dependency. It drives a real headless
 * Chrome/Edge, captures console errors, failed requests and screenshots, and
 * dispatches genuine input events (mouse, wheel, keyboard).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

export function resolveBrowserPath() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('No Chrome/Edge executable found. Set CHROME_PATH to a Chromium-based browser.')
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    const connection = new CdpConnection(socket)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${event.message ?? 'unknown'}`)), {
        once: true,
      })
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = connection.pending.get(message.id)
        if (!entry) return
        connection.pending.delete(message.id)
        if (message.error) entry.reject(new Error(`${entry.method} failed: ${message.error.message}`))
        else entry.resolve(message.result)
        return
      }
      const scoped = `${message.sessionId ?? ''}:${message.method}`
      for (const handler of connection.listeners.get(scoped) ?? []) handler(message.params, message.sessionId)
      for (const handler of connection.listeners.get(message.method) ?? []) handler(message.params, message.sessionId)
    })
    return connection
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.socket.send(JSON.stringify(payload))
    })
  }

  on(event, handler, sessionId) {
    const key = `${sessionId ?? ''}:${event}`
    const handlers = this.listeners.get(key) ?? []
    handlers.push(handler)
    this.listeners.set(key, handlers)
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }
}

/** Browser-level lifecycle: launch, open a page target, shut down. */
export async function launchBrowser({ port = 9333, width = 1600, height = 1000 } = {}) {
  const executable = resolveBrowserPath()
  const profile = await mkdtemp(join(tmpdir(), 'sqlviz-browser-qa-'))
  const args = [
    '--headless',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--mute-audio',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    'about:blank',
  ]
  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true })

  const endpoint = `http://127.0.0.1:${port}`
  let version = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Browser exited during startup with code ${child.exitCode}.`)
    }
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok) {
        version = await response.json()
        break
      }
    } catch {
      /* not listening yet */
    }
    await sleep(150)
  }
  if (version === null) throw new Error(`Browser did not expose ${endpoint}/json/version within 30s.`)

  const connection = await CdpConnection.connect(version.webSocketDebuggerUrl)

  return {
    executable,
    profile,
    version,
    connection,
    async openPage(url) {
      const target = await connection.send('Target.createTarget', { url: 'about:blank' })
      const attached = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
      const page = new Page(connection, attached.sessionId, target.targetId, { width, height })
      await page.init()
      await page.navigate(url)
      return page
    },
    async close() {
      connection.close()
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        /* best effort */
      }
    },
  }
}

/** One attached page target with convenience helpers. */
export class Page {
  constructor(connection, sessionId, targetId, viewport) {
    this.connection = connection
    this.sessionId = sessionId
    this.targetId = targetId
    this.viewportSize = viewport
    this.consoleMessages = []
    this.pageErrors = []
    this.failedRequests = []
    this.badResponses = []
    this.artifactDir = null
  }

  async init() {
    const { connection, sessionId } = this
    await connection.send('Page.enable', {}, sessionId)
    await connection.send('Runtime.enable', {}, sessionId)
    await connection.send('Log.enable', {}, sessionId)
    await connection.send('Network.enable', {}, sessionId)
    await connection.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: this.viewportSize.width,
        height: this.viewportSize.height,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    )

    connection.on(
      'Runtime.consoleAPICalled',
      (params) => {
        const text = (params.args ?? [])
          .map((arg) => {
            if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
            return arg.description ?? arg.unserializableValue ?? ''
          })
          .join(' ')
        this.consoleMessages.push({ type: params.type, text })
      },
      sessionId,
    )
    connection.on(
      'Runtime.exceptionThrown',
      (params) => {
        const details = params.exceptionDetails ?? {}
        const description = details.exception?.description ?? details.text ?? 'Unknown page exception'
        this.pageErrors.push(description)
      },
      sessionId,
    )
    connection.on(
      'Log.entryAdded',
      (params) => {
        const entry = params.entry ?? {}
        if (entry.level === 'error') this.consoleMessages.push({ type: 'log-error', text: `${entry.source}: ${entry.text}` })
      },
      sessionId,
    )
    connection.on(
      'Network.loadingFailed',
      (params) => {
        if (params.canceled) return
        this.failedRequests.push({ requestId: params.requestId, errorText: params.errorText, type: params.type })
      },
      sessionId,
    )
    connection.on(
      'Network.responseReceived',
      (params) => {
        const response = params.response ?? {}
        if (response.status >= 400) this.badResponses.push({ url: response.url, status: response.status })
      },
      sessionId,
    )
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, 20_000)
      this.connection.on(
        'Page.loadEventFired',
        () => {
          clearTimeout(timer)
          resolve()
        },
        this.sessionId,
      )
    })
    await this.connection.send('Page.navigate', { url }, this.sessionId)
    await loaded
  }

  async evaluate(expression) {
    const result = await this.connection.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      this.sessionId,
    )
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`Evaluation failed: ${description}\n--- expression ---\n${expression.slice(0, 500)}`)
    }
    return result.result.value
  }

  async waitFor(expression, { timeout = 20_000, label = expression.slice(0, 80), interval = 100 } = {}) {
    const deadline = Date.now() + timeout
    let lastError = null
    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate(expression)
        if (value) return value
      } catch (error) {
        lastError = error
      }
      await sleep(interval)
    }
    throw new Error(`Timed out waiting for: ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`)
  }

  /** Centre point of the first element matching a selector, or null. */
  async rect(selector) {
    return this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return null
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }
    })()`)
  }

  async rectByText(text) {
    return this.evaluate(`(() => {
      const wanted = ${JSON.stringify(text)}.toLowerCase()
      const element = [...document.querySelectorAll('button, [role="tab"], [role="option"]')]
        .find((candidate) => (candidate.textContent ?? '').trim().toLowerCase().startsWith(wanted))
      if (!element) return null
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return null
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height }
    })()`)
  }

  async clickAt(x, y) {
    const shared = { x, y, button: 'left', clickCount: 1 }
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, this.sessionId)
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...shared }, this.sessionId)
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...shared }, this.sessionId)
  }

  async click(selector) {
    const point = await this.rect(selector)
    if (point === null) throw new Error(`Cannot click missing element: ${selector}`)
    await this.clickAt(point.x, point.y)
    return point
  }

  async clickByText(text) {
    const point = await this.rectByText(text)
    if (point === null) throw new Error(`Cannot click element with text: ${text}`)
    await this.clickAt(point.x, point.y)
    return point
  }

  async wheel(x, y, deltaY, { deltaX = 0, modifiers = 0 } = {}) {
    await this.connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers, buttons: 0 },
      this.sessionId,
    )
  }

  async drag(from, to, { steps = 14 } = {}) {
    await this.connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 },
      this.sessionId,
    )
    await this.connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 },
      this.sessionId,
    )
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps
      const y = from.y + ((to.y - from.y) * step) / steps
      await this.connection.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x, y, button: 'left', buttons: 1 },
        this.sessionId,
      )
      await sleep(16)
    }
    await this.connection.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 },
      this.sessionId,
    )
  }

  async hoverAt(x, y) {
    await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, this.sessionId)
  }

  async key(key, code, windowsVirtualKeyCode) {
    await this.connection.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key, code, windowsVirtualKeyCode },
      this.sessionId,
    )
    await this.connection.send(
      'Input.dispatchKeyEvent',
      { type: 'keyUp', key, code, windowsVirtualKeyCode },
      this.sessionId,
    )
  }

  async insertText(text) {
    await this.connection.send('Input.insertText', { text }, this.sessionId)
  }

  async setArtifactDir(dir) {
    this.artifactDir = dir
    await mkdir(dir, { recursive: true })
  }

  async screenshot(name) {
    const shot = await this.connection.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      this.sessionId,
    )
    if (this.artifactDir === null) throw new Error('Artifact directory not set')
    const file = join(this.artifactDir, name)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    return file
  }

  async reload() {
    await this.connection.send('Page.reload', {}, this.sessionId)
    await this.waitFor(`document.readyState === 'complete'`, { label: 'page reload', timeout: 30_000 })
  }

  close() {
    void this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}
