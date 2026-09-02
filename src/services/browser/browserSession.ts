
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser as DriverBrowser, LaunchOptions, Page } from 'puppeteer-core'
import puppeteerPkg from 'puppeteer-core/package.json' with { type: 'json' }
import { getMercuryHome } from '../../utils/envUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import {
  driverNodeGate,
  resolveBrowser,
  type BrowserResolution,
} from './browserResolver.js'

export interface ConsoleEntry {
  at: number
  kind: string
  text: string
}

export const CONSOLE_RING_CAP = 250
export const CONSOLE_ENTRY_CAP = 300

interface Session {
  browser: DriverBrowser
  page: Page
  resolution: BrowserResolution
  driverVersion: string
  consoleRing: ConsoleEntry[]
  nav: { seq: number; seen: number }
  sandboxDowngraded: boolean
  popups: { count: number; last: string }
}

interface OwnerBrowserState {
  session: Session | null
  launching: boolean
  launchFlight: Promise<Session | EnsureSessionRefusal> | null
  disposed: boolean
  approvedOrigins: Set<string>
  approvedSecretPairings: Set<string>
  checkedActOrigin: { op: string; origin: string } | null
}

function killChild(browser: DriverBrowser): void {
  try {
    browser.process()?.kill()
  } catch {
  }
}

async function closeChild(browser: DriverBrowser): Promise<void> {
  try {
    await browser.close()
  } catch {
    killChild(browser)
  }
}

type LaunchDriver = (options: LaunchOptions) => Promise<DriverBrowser>
let launchDriverForProof: LaunchDriver | null = null
export function setBrowserLaunchDriverForProof(driver: LaunchDriver | null): void {
  launchDriverForProof = driver
}

const ownerStates = new OwnerScopedStore<OwnerBrowserState>({
  name: 'browser-sessions',
  create: () => ({
    session: null,
    launching: false,
    launchFlight: null,
    disposed: false,
    approvedOrigins: new Set(),
    approvedSecretPairings: new Set(),
    checkedActOrigin: null,
  }),
  dispose: async state => {
    state.disposed = true
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
    state.checkedActOrigin = null
    if (state.launchFlight !== null) await state.launchFlight.catch(() => undefined)
    const session = state.session
    state.session = null
    if (!session) return
    await closeChild(session.browser)
  },
  retain: state => state.session !== null || state.launching,
})
registerOwnerScopedStore(ownerStates)

let exitHookInstalled = false

export async function disposeBrowserOwner(owner: OwnerKey): Promise<void> {
  await ownerStates.disposeAsync(owner)
}

export const BROWSER_SESSION_CAP_DEFAULT = 3
export function browserSessionCap(): number {
  const raw = flagEnv('MERCURY_BROWSER_MAX_SESSIONS')
  if (raw === undefined || raw.trim() === '') return BROWSER_SESSION_CAP_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BROWSER_SESSION_CAP_DEFAULT
}

export function liveBrowserSessionCensus(): Array<{ owner: OwnerKey; lane: string; url: string | null }> {
  const rows: Array<{ owner: OwnerKey; lane: string; url: string | null }> = []
  for (const owner of ownerStates.owners()) {
    const state = ownerStates.peek(owner)
    if (!state) continue
    const live = state.session !== null && state.session.browser.connected
    if (!live && !state.launching) continue
    let lane = 'unknown'
    try {
      lane = parseOwnerKey(owner).lane
    } catch {
    }
    rows.push({ owner, lane, url: live ? state.session!.page.url() : null })
  }
  return rows
}

export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : u.protocol
  } catch {
    return 'unparseable:'
  }
}

export function noteCheckedActOrigin(owner: OwnerKey, op: string, origin: string): void {
  ownerStates.get(owner).checkedActOrigin = { op, origin }
}

export function consumeCheckedActOrigin(owner: OwnerKey, op: string): string | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  const held = state.checkedActOrigin
  state.checkedActOrigin = null
  return held !== null && held.op === op ? held.origin : null
}

export function originApproved(owner: OwnerKey, origin: string): boolean {
  return ownerStates.peek(owner)?.approvedOrigins.has(origin) ?? false
}

export function approveWebOrigin(owner: OwnerKey, url: string): void {
  const origin = originOf(url)
  if (origin.startsWith('http')) ownerStates.get(owner).approvedOrigins.add(origin)
}

export function approvedOriginList(owner: OwnerKey): string[] {
  return [...(ownerStates.peek(owner)?.approvedOrigins ?? [])]
}

function reapDeadSession(state: OwnerBrowserState): void {
  if (state.session && !state.session.browser.connected) {
    state.session = null
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
  }
}

export function activeSession(owner: OwnerKey): Session | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  reapDeadSession(state)
  return state.session
}

export function driverVersion(): string {
  return (puppeteerPkg as { version?: string }).version ?? 'bundled'
}

export type EnsureSessionRefusal = { state: 'unavailable' | 'at-capacity' | 'torn-down'; note: string }

export async function ensureBrowserSession(
  owner: OwnerKey,
  opts: { signal?: AbortSignal | undefined } = {},
): Promise<Session | EnsureSessionRefusal> {
  const state = ownerStates.get(owner)
  if (state.session && state.session.browser.connected) return state.session
  if (state.launchFlight !== null) return awaitLaunch(state.launchFlight, opts.signal)
  const flight = launchOwnerSession(owner, state)
  state.launchFlight = flight
  const clear = (): void => {
    if (state.launchFlight === flight) state.launchFlight = null
  }
  void flight.then(clear, clear)
  return awaitLaunch(flight, opts.signal)
}

function awaitLaunch(
  flight: Promise<Session | EnsureSessionRefusal>,
  signal: AbortSignal | undefined,
): Promise<Session | EnsureSessionRefusal> {
  if (signal === undefined) return flight
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    flight.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const err = new Error('the launch wait was interrupted')
  err.name = 'AbortError'
  return err
}

async function launchOwnerSession(owner: OwnerKey, state: OwnerBrowserState): Promise<Session | EnsureSessionRefusal> {
  if (state.session) {
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
  }
  state.session = null
  const gate = driverNodeGate()
  if (!gate.ok) return { state: 'unavailable', note: gate.note }
  const cap = browserSessionCap()
  const others = liveBrowserSessionCensus().filter(row => row.owner !== owner)
  if (others.length >= cap) {
    const lanes = others.map(row => row.lane).join(', ')
    return {
      state: 'at-capacity',
      note: `${others.length} of ${cap} concurrent browser sessions are live (${lanes}) — wait for one to finish, close one from its own lane (op:"close"), or raise MERCURY_BROWSER_MAX_SESSIONS`,
    }
  }
  const resolution = resolveBrowser()
  if (resolution.state === 'unavailable') {
    return { state: 'unavailable', note: `${resolution.note} — ${resolution.remedies.join('; ')}` }
  }
  state.launching = true
  let unhanded: DriverBrowser | null = null
  try {
    const launch: LaunchDriver =
      launchDriverForProof ?? (async options => (await import('puppeteer-core')).default.launch(options))
    const launchArgs = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-dev-shm-usage',
    ]
    const sandboxDowngraded =
      process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
    if (sandboxDowngraded) launchArgs.push('--no-sandbox')
    const browser = await launch({
      executablePath: resolution.executablePath,
      headless: true,
      env: subprocessEnv(),
      defaultViewport: { width: 1280, height: 800 },
      downloadBehavior: { policy: 'deny' },
      args: launchArgs,
    })
    unhanded = browser
    const pages = await browser.pages()
    const page = pages[0] ?? (await browser.newPage())
    const consoleRing: ConsoleEntry[] = []
    const nav = { seq: 0, seen: 0 }
    const popups = { count: 0, last: '' }
    const capture = (kind: string, text: string): void => {
      const bounded =
        text.length > CONSOLE_ENTRY_CAP
          ? `${text.slice(0, CONSOLE_ENTRY_CAP)}… [+${text.length - CONSOLE_ENTRY_CAP} chars]`
          : text
      consoleRing.push({ at: Date.now(), kind, text: bounded })
      if (consoleRing.length > CONSOLE_RING_CAP) consoleRing.shift()
    }
    const redactUrl = (url: string): string => {
      const q = url.indexOf('?')
      return q === -1 ? url : `${url.slice(0, q)}?…`
    }
    page.on('framenavigated', frame => {
      if (frame.parentFrame() === null) {
        nav.seq++
        capture('nav', `navigated to ${redactUrl(frame.url())}`)
      }
    })
    page.on('console', message => {
      const loc = message.location()
      const where = loc.url ? ` @ ${redactUrl(loc.url)}:${loc.lineNumber ?? 0}` : ''
      const args = message.args()
      if (args.length === 0) {
        capture(message.type(), `${message.text()}${where}`)
        return
      }
      void Promise.all(args.map(a => a.jsonValue().catch(() => undefined)))
        .then(vals => {
          const rendered = vals
            .map(v => (v === undefined ? '<unserializable>' : typeof v === 'string' ? v : JSON.stringify(v)))
            .join(' ')
          capture(message.type(), `${rendered.trim() !== '' ? rendered : message.text()}${where}`)
        })
        .catch(() => capture(message.type(), `${message.text()}${where}`))
    })
    page.on('pageerror', err => {
      const e = err as Error | undefined
      const stack = (e?.stack ?? '')
        .split('\n')
        .slice(1, 4)
        .map(l => l.trim())
        .filter(Boolean)
      capture('pageerror', `${String(e?.message ?? err)}${stack.length > 0 ? ` | ${stack.join(' | ')}` : ''}`)
    })
    page.on('popup', popup => {
      if (!popup) return
      void (async () => {
        let url = popup.url()
        if (!url || url === 'about:blank') {
          await new Promise(r => setTimeout(r, 300))
          url = popup.url()
        }
        popups.count++
        popups.last = redactUrl(url || '(unknown)')
        capture('popup', `the page opened a new tab: ${popups.last} — closed unadopted (one owned page; op:"open" follows it)`)
        await popup.close().catch(() => {})
      })()
    })
    page.on('requestfailed', request => {
      capture(
        'net',
        `${request.method()} ${redactUrl(request.url())} FAILED ${request.failure()?.errorText ?? ''} (${request.resourceType()})`,
      )
    })
    page.on('response', response => {
      const status = response.status()
      if (status < 400) return
      const req = response.request()
      capture('net', `${req.method()} ${redactUrl(response.url())} ${status} (${req.resourceType()})`)
    })
    page.on('dialog', dialog => {
      const kind = dialog.type()
      const verb = kind === 'beforeunload' ? 'accepted' : 'dismissed'
      capture('dialog', `${kind}("${dialog.message()}") auto-${verb} — the page was blocked on it`)
      void (kind === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {
      })
    })
    if (state.disposed) {
      return {
        state: 'torn-down',
        note: 'the owner was torn down while its browser launch was in flight — the child was closed, nothing is open',
      }
    }
    state.session = {
      browser,
      page,
      resolution,
      driverVersion: (puppeteerPkg as { version?: string }).version ?? 'bundled',
      consoleRing,
      nav,
      sandboxDowngraded,
      popups,
    }
    unhanded = null
  } finally {
    state.launching = false
    if (unhanded !== null) await closeChild(unhanded)
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const key of ownerStates.owners()) {
        const st = ownerStates.peek(key)
        if (st?.session) killChild(st.session.browser)
      }
    })
  }
  return state.session
}

export async function closeBrowserSession(owner: OwnerKey): Promise<boolean> {
  const state = ownerStates.peek(owner)
  if (!state) return false
  if (state.launchFlight !== null) await state.launchFlight.catch(() => undefined)
  if (!state.session) return false
  const session = state.session
  await closeChild(session.browser)
  state.session = null
  state.approvedOrigins.clear()
  state.approvedSecretPairings.clear()
  return true
}

export function secretPairingKey(ref: string, origin: string): string {
  return `${ref}@${origin}`
}

export function secretPairingApproved(owner: OwnerKey, ref: string, origin: string): boolean {
  return ownerStates.peek(owner)?.approvedSecretPairings.has(secretPairingKey(ref, origin)) ?? false
}

export function approveSecretPairing(owner: OwnerKey, ref: string, origin: string): void {
  if (origin.startsWith('http')) ownerStates.get(owner).approvedSecretPairings.add(secretPairingKey(ref, origin))
}

export function screenshotPath(label: string): string {
  const dir = path.join(getMercuryHome(), 'browser-shots')
  fs.mkdirSync(dir, { recursive: true })
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'shot'
  return path.join(dir, `${Date.now()}-${safe}.png`)
}
