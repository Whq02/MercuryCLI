
import { ChildProcess } from 'node:child_process'
import { chromeNetErrorFor, startMetadataProxy } from './metadataProxy.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser as DriverBrowser, HTTPRequest, LaunchOptions, Page } from 'puppeteer-core'
import puppeteerPkg from 'puppeteer-core/package.json' with { type: 'json' }
import { getMercuryHome } from '../../utils/envUtils.js'
import { endProcessTree } from '../../utils/processGroup.js'
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
  navFailure: { last: NavFailure | null }
  networkRefusal: { count: number; last: string | null }
  policyBlocks: Map<string, { reason: string; at: number }>
  closeNetwork: () => void
  downloads: { count: number; last: DownloadNotice | null; waiters: Array<() => void> }
  navWatch: { pendingUrl: string | null; abortedAt: number; waiters: Array<() => void> }
  profileOrigin: string | null
  profileDir: string | null
  headless: boolean
  cursor: { x: number; y: number }
}

export interface NavFailure {
  url: string
  errorText: string
  at: number
}

export interface DownloadNotice {
  guid: string
  url: string
  filename: string
  bytes: number | null
  type: string | null
  at: number
  done: Promise<void>
}

export function isBrowserErrorPage(url: string): boolean {
  return url.startsWith('chrome-error://')
}

interface OwnerBrowserState {
  session: Session | null
  launching: boolean
  launchFlight: Promise<Session | EnsureSessionRefusal> | null
  disposed: boolean
  approvedOrigins: Set<string>
  approvedSecretPairings: Set<string>
  checkedActOrigin: { op: string; origin: string } | null
  goneAt: number | null
  activeCalls: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

export const BROWSER_CLOSE_BOUND_MS = 3_000
export const BROWSER_PROTOCOL_TIMEOUT_MS = 90_000
export const NAVIGATION_CAP_MS = BROWSER_PROTOCOL_TIMEOUT_MS
const BROWSER_IDLE_MS = 300_000

function clearIdleLease(state: OwnerBrowserState): void {
  if (state.idleTimer !== null) clearTimeout(state.idleTimer)
  state.idleTimer = null
}

function armIdleLease(state: OwnerBrowserState): void {
  clearIdleLease(state)
  if (state.disposed || state.activeCalls > 0 || state.launching || state.session === null) return
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    if (state.activeCalls > 0 || state.launching || state.session === null) return
    const browser = state.session.browser
    markSessionGone(state, browser)
    void closeChild(browser)
  }, BROWSER_IDLE_MS)
  state.idleTimer.unref?.()
}

export function beginBrowserActivity(owner: OwnerKey): () => void {
  const state = ownerStates.get(owner)
  clearIdleLease(state)
  state.activeCalls++
  let released = false
  return () => {
    if (released) return
    released = true
    state.activeCalls--
    armIdleLease(state)
  }
}

export type CloseOutcome = 'closed' | 'killed' | 'gone'

export function tempProfileDirOf(browser: DriverBrowser): string | null {
  const args = browser.process()?.spawnargs ?? []
  const arg = args.find(a => a.startsWith('--user-data-dir='))
  if (arg === undefined) return null
  const dir = arg.slice('--user-data-dir='.length)
  return /^puppeteer_dev_[a-z]+_profile-/.test(path.basename(dir)) ? dir : null
}

export function removeTempProfile(browser: DriverBrowser): boolean {
  const dir = tempProfileDirOf(browser)
  if (dir === null || !fs.existsSync(dir)) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    return false
  }
  return true
}

function killChild(browser: DriverBrowser): void {
  const child = browser.process()
  if (!child) return
  try {
    child.kill('SIGKILL')
  } catch {
    return
  }
}

async function endChild(browser: DriverBrowser): Promise<void> {
  const child = browser.process()
  if (!child) return
  if (child instanceof ChildProcess) {
    await endProcessTree(child, 'SIGKILL')
    removeTempProfile(browser)
    return
  }
  killChild(browser)
  removeTempProfile(browser)
}

export function childGone(browser: DriverBrowser): boolean {
  if (browser.connected === false) return true
  const child = browser.process()
  if (child === null || child === undefined) return false
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

async function closeChild(browser: DriverBrowser): Promise<CloseOutcome> {
  if (childGone(browser)) {
    await endChild(browser)
    return 'gone'
  }
  let bound: ReturnType<typeof setTimeout> | undefined
  const lapse = new Promise<'lapsed'>(resolve => {
    bound = setTimeout(() => resolve('lapsed'), BROWSER_CLOSE_BOUND_MS)
  })
  try {
    const won = await Promise.race([browser.close().then(() => 'closed' as const), lapse])
    if (won === 'lapsed') {
      await endChild(browser)
      return 'killed'
    }
    removeTempProfile(browser)
    return 'closed'
  } catch {
    await endChild(browser)
    return 'killed'
  } finally {
    if (bound !== undefined) clearTimeout(bound)
  }
}

type LaunchDriver = (options: LaunchOptions) => Promise<DriverBrowser>
let launchDriverForProof: LaunchDriver | null = null
export function setBrowserLaunchDriverForProof(driver: LaunchDriver | null): void {
  launchDriverForProof = driver
}

const ownerStates = new OwnerScopedStore<OwnerBrowserState>({
  name: 'browser-sessions',
  live: true,
  create: () => ({
    session: null,
    launching: false,
    launchFlight: null,
    disposed: false,
    approvedOrigins: new Set(),
    approvedSecretPairings: new Set(),
    checkedActOrigin: null,
    goneAt: null,
    activeCalls: 0,
    idleTimer: null,
  }),
  dispose: async state => {
    state.disposed = true
    clearIdleLease(state)
    state.approvedOrigins.clear()
    state.approvedSecretPairings.clear()
    state.checkedActOrigin = null
    if (state.launchFlight !== null) await state.launchFlight.catch(() => undefined)
    const session = state.session
    state.session = null
    if (!session) return
    session.closeNetwork()
    await closeChild(session.browser)
  },
  retain: state => state.session !== null || state.launching || state.activeCalls > 0,
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
  if (state.session && childGone(state.session.browser)) markSessionGone(state, state.session.browser)
}

function markSessionGone(state: OwnerBrowserState, browser: DriverBrowser): void {
  if (state.session === null || state.session.browser !== browser) return
  clearIdleLease(state)
  state.session.closeNetwork()
  state.session = null
  state.approvedOrigins.clear()
  state.approvedSecretPairings.clear()
  state.checkedActOrigin = null
  state.goneAt = Date.now()
}

export function activeSession(owner: OwnerKey): Session | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  reapDeadSession(state)
  return state.session
}

export function sessionGoneAt(owner: OwnerKey): number | null {
  const state = ownerStates.peek(owner)
  if (!state) return null
  reapDeadSession(state)
  return state.session === null ? state.goneAt : null
}

export function driverVersion(): string {
  return (puppeteerPkg as { version?: string }).version ?? 'bundled'
}

export type EnsureSessionRefusal = { state: 'unavailable' | 'at-capacity' | 'torn-down'; note: string }

export interface EnsureBrowserSessionOptions {
  signal?: AbortSignal | undefined
  origin?: string | undefined
  headless?: boolean | undefined
}

export function browserProfileDirForOrigin(urlOrOrigin: string, owner?: OwnerKey): string | null {
  if (typeof urlOrOrigin !== 'string' || urlOrOrigin.trim() === '' || /[\s;"'\\]/.test(urlOrOrigin)) return null
  const origin = originOf(urlOrOrigin)
  if (!origin.startsWith('http://') && !origin.startsWith('https://')) return null
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return null
  }
  if (u.origin !== origin || !u.hostname || u.hostname.includes('..')) return null
  const scheme = u.protocol === 'https:' ? 'https' : 'http'
  const host = u.hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '_').replace(/^\.+|\.+$/g, '')
  if (!host) return null
  const port = u.port ? `-${u.port}` : ''
  const slug = `${scheme}-${host}${port}`.slice(0, 100)
  const root = path.resolve(getMercuryHome(), 'browser-profiles')
  let candidate = path.resolve(root, slug)
  if (!candidate.startsWith(root + path.sep)) return null
  if (owner !== undefined) {
    const busy = ownerStates.owners().some(other => {
      if (other === owner) return false
      const st = ownerStates.peek(other)
      return Boolean(st?.session?.browser.connected && st.session.profileDir === candidate)
    })
    if (busy) {
      let lane = 'lane'
      try {
        lane = parseOwnerKey(owner).lane.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32) || 'lane'
      } catch {}
      candidate = path.resolve(root, `${slug}--${lane}`)
      if (!candidate.startsWith(root + path.sep)) return null
    }
  }
  return candidate
}

export function resolveHostLanguages(localeOverride?: string): {
  primary: string
  languages: string[]
  acceptLanguage: string
} {
  let raw = 'en-US'
  try {
    const resolved = localeOverride ?? Intl.DateTimeFormat().resolvedOptions().locale
    if (resolved && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(resolved) && resolved !== 'C' && resolved !== 'POSIX') {
      const parts = resolved.split('-')
      const lang = parts[0]!.toLowerCase()
      raw = parts.length >= 2 ? `${lang}-${parts[1]!.toUpperCase()}` : lang === 'en' ? 'en-US' : lang
    }
  } catch {}
  const base = raw.split('-')[0] || 'en'
  const languages = raw.includes('-') && base !== raw ? [raw, base] : [raw, 'en'].filter((v, i, a) => a.indexOf(v) === i)
  const acceptLanguage = languages.join(',')
  return { primary: languages[0]!, languages, acceptLanguage }
}

export function resolveNavigatorPlatform(
  cleanUa: string,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const isMac = cleanUa.includes('Macintosh') || platform === 'darwin'
  if (isMac) return 'MacIntel'
  const isWin = cleanUa.includes('Windows') || platform === 'win32'
  if (isWin) return 'Win32'
  return cleanUa.includes('aarch64') || arch === 'arm64' ? 'Linux aarch64' : 'Linux x86_64'
}

function resolveHostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function pageStealthInit(langs: string[]): void {
  const nativeStrings = new WeakMap<Function, string>()
  const origToString = Function.prototype.toString
  const markNative = <T extends Function>(fn: T, name: string): T => {
    nativeStrings.set(fn, `function ${name}() { [native code] }`)
    return fn
  }
  const patchedToString = function toString(this: Function): string {
    if (typeof this === 'function' && nativeStrings.has(this)) {
      return nativeStrings.get(this)!
    }
    return origToString.call(this)
  }
  markNative(patchedToString, 'toString')
  Object.defineProperty(Function.prototype, 'toString', {
    value: patchedToString,
    writable: true,
    enumerable: false,
    configurable: true,
  })
  const navProto = Object.getPrototypeOf(navigator)
  if (navigator.webdriver !== false) {
    Object.defineProperty(navProto, 'webdriver', {
      get: markNative(function webdriver() {
        return false
      }, 'get webdriver'),
      enumerable: true,
      configurable: true,
    })
  }
  if (Object.prototype.hasOwnProperty.call(navigator, 'webdriver')) {
    try {
      delete (navigator as unknown as Record<string, unknown>).webdriver
    } catch {}
  }
  const frozenLangs = Object.freeze([...langs])
  const primaryLang = frozenLangs[0] ?? 'en-US'
  Object.defineProperty(navProto, 'language', {
    get: markNative(function language() {
      return primaryLang
    }, 'get language'),
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(navProto, 'languages', {
    get: markNative(function languages() {
      return frozenLangs
    }, 'get languages'),
    enumerable: true,
    configurable: true,
  })
  const w = window as unknown as Record<string, unknown>
  if (!('chrome' in w) || typeof w.chrome !== 'object' || w.chrome === null) {
    Object.defineProperty(w, 'chrome', {
      value: {},
      writable: true,
      enumerable: true,
      configurable: false,
    })
  }
  const chromeObj = w.chrome as Record<string, unknown>
  if (!('app' in chromeObj) || !chromeObj.app) {
    chromeObj.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: markNative(function getDetails() {
        if (arguments.length) throw new TypeError('Error in invocation of app.getDetails()')
        return null
      }, 'getDetails'),
      getIsInstalled: markNative(function getIsInstalled() {
        if (arguments.length) throw new TypeError('Error in invocation of app.getIsInstalled()')
        return false
      }, 'getIsInstalled'),
      runningState: markNative(function runningState() {
        if (arguments.length) throw new TypeError('Error in invocation of app.runningState()')
        return 'cannot_run'
      }, 'runningState'),
    }
  }
  if (!('csi' in chromeObj) || typeof chromeObj.csi !== 'function') {
    chromeObj.csi = markNative(function csi() {
      const t = window.performance?.timing
      const start = t?.navigationStart || Date.now()
      return {
        onloadT: t?.domContentLoadedEventEnd || start,
        startE: start,
        pageT: Date.now() - start,
        tran: 15,
      }
    }, 'csi')
  }
  if (!('loadTimes' in chromeObj) || typeof chromeObj.loadTimes !== 'function') {
    chromeObj.loadTimes = markNative(function loadTimes() {
      const t = window.performance?.timing
      const navEntry = (window.performance?.getEntriesByType?.('navigation')?.[0] ?? null) as {
        nextHopProtocol?: string
        type?: string
      } | null
      const hop = navEntry?.nextHopProtocol || 'h2'
      const start = (t?.navigationStart || Date.now()) / 1000
      return {
        connectionInfo: hop,
        npnNegotiatedProtocol: hop,
        navigationType: navEntry?.type || 'other',
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: hop === 'h2' || hop === 'hq',
        wasNpnNegotiated: hop === 'h2' || hop === 'hq',
        firstPaintAfterLoadTime: 0,
        requestTime: start,
        startLoadTime: start,
        commitLoadTime: (t?.responseStart || Date.now()) / 1000,
        finishDocumentLoadTime: (t?.domContentLoadedEventEnd || Date.now()) / 1000,
        finishLoadTime: (t?.loadEventEnd || Date.now()) / 1000,
        firstPaintTime: start,
      }
    }, 'loadTimes')
  }
  if (!('runtime' in chromeObj) || !chromeObj.runtime) {
    const validExtId = (s: unknown): s is string => typeof s === 'string' && /^[a-p]{32}$/i.test(s)
    const sendMessage = markNative(function sendMessage(extId?: unknown, _msg?: unknown, opts?: unknown, cb?: unknown) {
      const pre =
        'Error in invocation of runtime.sendMessage(optional string extensionId, any message, optional object options, optional function responseCallback): '
      if (arguments.length === 0 || arguments.length > 4 || (opts && typeof opts !== 'object') || (cb && typeof cb !== 'function')) {
        throw new TypeError(`${pre}No matching signature.`)
      }
      if (arguments.length < 2) {
        throw new TypeError(`${pre}chrome.runtime.sendMessage() called from a webpage must specify an Extension ID (string) for its first argument.`)
      }
      if (typeof extId !== 'string') throw new TypeError(`${pre}No matching signature.`)
      if (!validExtId(extId)) throw new TypeError(`${pre}Invalid extension id: '${extId}'`)
      return undefined
    }, 'sendMessage')
    const connect = markNative(function connect(extId?: unknown, info?: unknown) {
      const pre = 'Error in invocation of runtime.connect(optional string extensionId, optional object connectInfo): '
      if (arguments.length === 0 || (arguments.length === 1 && extId === '')) {
        throw new TypeError(`${pre}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
      }
      if (arguments.length > 2 || (info && typeof info !== 'object')) {
        throw new TypeError(`${pre}No matching signature.`)
      }
      if (typeof extId !== 'string') {
        throw new TypeError(`${pre}chrome.runtime.connect() called from a webpage must specify an Extension ID (string) for its first argument.`)
      }
      if (!validExtId(extId)) throw new TypeError(`${pre}Invalid extension id: '${extId}'`)
      const ev = () => ({
        addListener: markNative(function addListener() {}, 'addListener'),
        dispatch: markNative(function dispatch() {}, 'dispatch'),
        hasListener: markNative(function hasListener() {}, 'hasListener'),
        hasListeners: markNative(function hasListeners() {
          return false
        }, 'hasListeners'),
        removeListener: markNative(function removeListener() {}, 'removeListener'),
      })
      return {
        name: '',
        sender: undefined,
        disconnect: markNative(function disconnect() {}, 'disconnect'),
        onDisconnect: ev(),
        onMessage: ev(),
        postMessage: markNative(function postMessage() {
          if (!arguments.length) throw new TypeError('Insufficient number of arguments.')
          throw new Error('Attempting to use a disconnected port object')
        }, 'postMessage'),
      }
    }, 'connect')
    chromeObj.runtime = {
      OnInstalledReason: {
        CHROME_UPDATE: 'chrome_update',
        INSTALL: 'install',
        SHARED_MODULE_UPDATE: 'shared_module_update',
        UPDATE: 'update',
      },
      OnRestartRequiredReason: {
        APP_UPDATE: 'app_update',
        OS_UPDATE: 'os_update',
        PERIODIC: 'periodic',
      },
      PlatformArch: {
        ARM: 'arm',
        ARM64: 'arm64',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformNaclArch: {
        ARM: 'arm',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformOs: {
        ANDROID: 'android',
        CROS: 'cros',
        LINUX: 'linux',
        MAC: 'mac',
        OPENBSD: 'openbsd',
        WIN: 'win',
      },
      RequestUpdateCheckStatus: {
        NO_UPDATE: 'no_update',
        THROTTLED: 'throttled',
        UPDATE_AVAILABLE: 'update_available',
      },
      id: undefined,
      connect,
      sendMessage,
    }
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    Object.defineProperty(Notification, 'permission', {
      get: markNative(function permission() {
        return 'default'
      }, 'get permission'),
      enumerable: true,
      configurable: true,
    })
  }
  if (typeof Permissions !== 'undefined' && Permissions.prototype && typeof Permissions.prototype.query === 'function') {
    const origQuery = Permissions.prototype.query
    const query = markNative(function query(this: Permissions, desc: PermissionDescriptor) {
      return origQuery.call(this, desc).then(status => {
        if (desc && (desc as { name?: string }).name === 'notifications' && typeof Notification !== 'undefined') {
          const expected = Notification.permission === 'default' ? 'prompt' : Notification.permission
          if (status.state !== expected) {
            return new Proxy(status, {
              get(target, prop) {
                if (prop === 'state') return expected
                const val = Reflect.get(target, prop, target)
                return typeof val === 'function' ? val.bind(target) : val
              },
            })
          }
        }
        return status
      })
    }, 'query')
    Object.defineProperty(Permissions.prototype, 'query', {
      value: query,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  const patchWebGL = (ctor: { prototype?: { getParameter?: Function } } | undefined) => {
    const proto = ctor?.prototype
    if (!proto || typeof proto.getParameter !== 'function') return
    const origGetParameter = proto.getParameter
    const getParameter = markNative(function getParameter(this: unknown, param: number) {
      const val = origGetParameter.call(this, param)
      if (param === 37445) {
        if (!val || /SwiftShader|Brian Paul|Mesa|llvmpipe|Google Inc\.\s*\(Google\)/i.test(String(val))) {
          return 'Intel Inc.'
        }
      }
      if (param === 37446) {
        if (!val || /SwiftShader|OffScreen|Brian Paul|llvmpipe|Subzero/i.test(String(val))) {
          return 'Intel Iris OpenGL Engine'
        }
      }
      if (param === 0x1f00 && /Brian Paul/i.test(String(val))) return 'WebKit'
      if (param === 0x1f01 && /Mesa OffScreen|SwiftShader/i.test(String(val))) return 'WebKit WebGL'
      return val
    }, 'getParameter')
    Object.defineProperty(proto, 'getParameter', {
      value: getParameter,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
  patchWebGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : undefined)
  patchWebGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : undefined)
  if (
    navigator.plugins.length === 0 &&
    typeof PluginArray !== 'undefined' &&
    typeof Plugin !== 'undefined' &&
    typeof MimeTypeArray !== 'undefined' &&
    typeof MimeType !== 'undefined'
  ) {
    const pluginNames = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF']
    const mimeDefs = [
      { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    ]
    const mimeArr = Object.create(MimeTypeArray.prototype)
    const pluginArr = Object.create(PluginArray.prototype)
    pluginNames.forEach((pName, pIdx) => {
      const pObj = Object.create(Plugin.prototype)
      Object.defineProperties(pObj, {
        name: { value: pName, enumerable: true },
        filename: { value: 'internal-pdf-viewer', enumerable: true },
        description: { value: 'Portable Document Format', enumerable: true },
        length: { value: mimeDefs.length, enumerable: true },
      })
      mimeDefs.forEach((mDef, mIdx) => {
        const mObj = Object.create(MimeType.prototype)
        Object.defineProperties(mObj, {
          type: { value: mDef.type, enumerable: true },
          suffixes: { value: mDef.suffixes, enumerable: true },
          description: { value: mDef.description, enumerable: true },
          enabledPlugin: { value: pObj, enumerable: true },
        })
        Object.defineProperty(pObj, mIdx, { value: mObj, enumerable: true })
        Object.defineProperty(pObj, mDef.type, { value: mObj, enumerable: false })
        if (pIdx === 0) {
          Object.defineProperty(mimeArr, mIdx, { value: mObj, enumerable: true })
          Object.defineProperty(mimeArr, mDef.type, { value: mObj, enumerable: false })
        }
      })
      pObj.item = markNative(function item(idx: number) {
        return pObj[idx] ?? null
      }, 'item')
      pObj.namedItem = markNative(function namedItem(k: string) {
        return pObj[k] ?? null
      }, 'namedItem')
      Object.defineProperty(pluginArr, pIdx, { value: pObj, enumerable: true })
      Object.defineProperty(pluginArr, pName, { value: pObj, enumerable: false })
    })
    Object.defineProperty(pluginArr, 'length', { value: pluginNames.length, enumerable: true })
    pluginArr.item = markNative(function item(idx: number) {
      return pluginArr[idx] ?? null
    }, 'item')
    pluginArr.namedItem = markNative(function namedItem(k: string) {
      return pluginArr[k] ?? null
    }, 'namedItem')
    pluginArr.refresh = markNative(function refresh() {}, 'refresh')
    Object.defineProperty(mimeArr, 'length', { value: mimeDefs.length, enumerable: true })
    mimeArr.item = markNative(function item(idx: number) {
      return mimeArr[idx] ?? null
    }, 'item')
    mimeArr.namedItem = markNative(function namedItem(k: string) {
      return mimeArr[k] ?? null
    }, 'namedItem')
    Object.defineProperty(navProto, 'plugins', {
      get: markNative(function plugins() {
        return pluginArr
      }, 'get plugins'),
      enumerable: true,
      configurable: true,
    })
    Object.defineProperty(navProto, 'mimeTypes', {
      get: markNative(function mimeTypes() {
        return mimeArr
      }, 'get mimeTypes'),
      enumerable: true,
      configurable: true,
    })
  }
  const origOuterW = Object.getOwnPropertyDescriptor(window, 'outerWidth')
  const origOuterH = Object.getOwnPropertyDescriptor(window, 'outerHeight')
  Object.defineProperty(window, 'outerWidth', {
    get: markNative(function outerWidth() {
      const raw = origOuterW?.get ? origOuterW.get.call(window) : (origOuterW?.value ?? 0)
      const inner = window.innerWidth || 1280
      return typeof raw === 'number' && raw >= inner ? raw : inner
    }, 'get outerWidth'),
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(window, 'outerHeight', {
    get: markNative(function outerHeight() {
      const raw = origOuterH?.get ? origOuterH.get.call(window) : (origOuterH?.value ?? 0)
      const inner = window.innerHeight || 800
      return typeof raw === 'number' && raw >= inner ? raw : inner + 85
    }, 'get outerHeight'),
    enumerable: true,
    configurable: true,
  })
}

export async function ensureBrowserSession(
  owner: OwnerKey,
  opts: EnsureBrowserSessionOptions = {},
): Promise<Session | EnsureSessionRefusal> {
  const state = ownerStates.get(owner)
  const wantedOrigin = opts.origin && opts.origin.startsWith('http') ? originOf(opts.origin) : null
  if (state.session && state.session.browser.connected) {
    const sameHeadless = opts.headless === undefined || state.session.headless === opts.headless
    const sameOrigin = wantedOrigin === null || state.session.profileOrigin === wantedOrigin
    if (sameHeadless && sameOrigin) {
      armIdleLease(state)
      return state.session
    }
  }
  if (state.launchFlight !== null) return awaitLaunch(state.launchFlight, opts.signal)
  const flight = launchOwnerSession(owner, state, opts)
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

async function launchOwnerSession(
  owner: OwnerKey,
  state: OwnerBrowserState,
  opts: EnsureBrowserSessionOptions = {},
): Promise<Session | EnsureSessionRefusal> {
  reapDeadSession(state)
  const gate = driverNodeGate()
  if (!gate.ok) return { state: 'unavailable', note: gate.note }
  const cap = browserSessionCap()
  const identity = parseOwnerKey(owner)
  const others = liveBrowserSessionCensus().filter(row => {
    if (row.owner === owner) return false
    const other = parseOwnerKey(row.owner)
    return other.workspace === identity.workspace && other.sessionId === identity.sessionId && other.lane !== 'main'
  })
  if (identity.lane !== 'main' && others.length >= cap) {
    const lanes = others.map(row => row.lane).join(', ')
    return {
      state: 'at-capacity',
      note: `${others.length} of ${cap} child browser sessions are live in this parent session (${lanes}); the lead has a separate slot. Close a finished session with op:"close", wait for its 5-minute idle lease to expire, or raise MERCURY_BROWSER_MAX_SESSIONS.`,
    }
  }
  const resolution = resolveBrowser()
  if (resolution.state === 'unavailable') {
    return { state: 'unavailable', note: `${resolution.note} — ${resolution.remedies.join('; ')}` }
  }
  const rotating = state.session && state.session.browser.connected ? state.session : null
  state.session = null
  state.launching = true
  let unhanded: DriverBrowser | null = null
  let proxyClose: (() => void) | undefined
  const networkRefusal: Session['networkRefusal'] = { count: 0, last: null }
  const relayFailures = new Map<string, { code: string; at: number }>()
  const relayFailureFor = (url: string): { code: string; at: number } | null => {
    let origin = ''
    try { origin = new URL(url).origin } catch { return null }
    const hit = relayFailures.get(url) ?? relayFailures.get(origin)
    if (hit === undefined || Date.now() - hit.at > 15_000) return null
    return hit
  }
  try {
    if (rotating !== null) {
      ;(rotating as { closeNetwork?: () => void }).closeNetwork?.()
      await closeChild(rotating.browser)
    }
    const proxy = await startMetadataProxy(
      reason => { networkRefusal.last = reason; networkRefusal.count++ },
      (target, code) => {
        relayFailures.set(target, { code, at: Date.now() })
        if (relayFailures.size > 32) relayFailures.delete(relayFailures.keys().next().value!)
      },
    )
    proxyClose = proxy.close
    const launch: LaunchDriver =
      launchDriverForProof ?? (async options => (await import('puppeteer-core')).default.launch(options))
    const hostLang = resolveHostLanguages()
    const hostTimeZone = resolveHostTimeZone()
    const profileOrigin = opts.origin && opts.origin.startsWith('http') ? originOf(opts.origin) : null
    const profileDir = profileOrigin ? browserProfileDirForOrigin(profileOrigin, owner) : null
    if (profileDir && launchDriverForProof === null) {
      const profilesRoot = path.dirname(profileDir)
      fs.mkdirSync(profilesRoot, { recursive: true, mode: 0o700 })
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(profilesRoot, 0o700)
          fs.chmodSync(profileDir, 0o700)
        } catch {}
      }
      const heldElsewhere = ownerStates.owners().some(other => {
        if (other === owner) return false
        const st = ownerStates.peek(other)
        return Boolean(st?.session?.browser.connected && st.session.profileDir === profileDir)
      })
      if (!heldElsewhere) {
        for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
          try {
            fs.rmSync(path.join(profileDir, lockName), { force: true })
          } catch {}
        }
      }
    }
    const headless = opts.headless ?? true
    const launchArgs = [
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
      `--lang=${hostLang.primary}`,
    ]
    const sandboxDowngraded =
      process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
    if (sandboxDowngraded) launchArgs.push('--no-sandbox')
    const browser = await launch({
      executablePath: resolution.executablePath,
      headless,
      protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
      env: subprocessEnv(),
      defaultViewport: { width: 1280, height: 800 },
      downloadBehavior: { policy: 'deny' },
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages',
      ],
      ...(profileDir ? { userDataDir: profileDir } : {}),
      args: launchArgs,
    })
    unhanded = browser
    const pages = await browser.pages()
    const page = pages[0] ?? (await browser.newPage())
    if (typeof page.evaluateOnNewDocument === 'function') {
      await page.evaluateOnNewDocument(pageStealthInit, hostLang.languages).catch(() => undefined)
      await page.evaluate(pageStealthInit, hostLang.languages).catch(() => undefined)
    }
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
    const navFailure: Session['navFailure'] = { last: null }
    const policyBlocks: Session['policyBlocks'] = new Map()
    const downloads: Session['downloads'] = { count: 0, last: null, waiters: [] }
    const navWatch: Session['navWatch'] = { pendingUrl: null, abortedAt: 0, waiters: [] }
    const docResponses = new Map<string, string | null>()
    const settleNav = (): void => {
      navWatch.pendingUrl = null
      for (const wake of navWatch.waiters.splice(0)) wake()
    }
    const isMainNavigation = (request: HTTPRequest): boolean =>
      request.isNavigationRequest() && request.frame() === page.mainFrame()
    page.on('framenavigated', frame => {
      if (frame.parentFrame() === null) {
        nav.seq++
        if (!isBrowserErrorPage(frame.url())) navFailure.last = null
        settleNav()
        capture('nav', `navigated to ${redactUrl(frame.url())}`)
      }
    })
    page.on('request', request => {
      if (isMainNavigation(request)) navWatch.pendingUrl = redactUrl(request.url())
    })
    page.on('requestfinished', request => {
      if (isMainNavigation(request)) settleNav()
    })
    const cdp =
      typeof page.createCDPSession === 'function' ? await page.createCDPSession().catch(() => null) : null
    if (cdp !== null) {
      const requests = new Map<string, string>()
      await cdp.send('Network.enable').catch(() => undefined)
      cdp.on('Network.requestWillBeSent', event => {
        requests.set(event.requestId, event.request.url.split('?')[0]!)
        if (requests.size > CONSOLE_RING_CAP) requests.delete(requests.keys().next().value!)
      })
      cdp.on('Network.loadingFinished', event => { requests.delete(event.requestId) })
      cdp.on('Network.loadingFailed', event => {
        const url = requests.get(event.requestId)
        requests.delete(event.requestId)
        if (url === undefined || event.blockedReason === undefined) return
        policyBlocks.set(url, { reason: event.blockedReason, at: Date.now() })
        if (policyBlocks.size > CONSOLE_RING_CAP) policyBlocks.delete(policyBlocks.keys().next().value!)
        capture('net', `${url} refused by browser policy: ${event.blockedReason}`)
      })
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined)
      await cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(() => undefined)
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: hostTimeZone }).catch(() => undefined)
      const rawUa = typeof browser.userAgent === 'function' ? await browser.userAgent().catch(() => '') : ''
      const cleanUa = rawUa.replace(/HeadlessChrome\//g, 'Chrome/')
      if (cleanUa) {
        const versionStr = typeof browser.version === 'function' ? await browser.version().catch(() => '') : ''
        const fullVersion =
          resolution.buildId ??
          (/(\d+\.\d+\.\d+\.\d+)/.exec(versionStr)?.[1] ??
            (/Chrome\/(\d+\.\d+\.\d+\.\d+)/.exec(cleanUa)?.[1] ?? '155.0.0.0'))
        const major = fullVersion.split('.')[0] || '155'
        const isMac = cleanUa.includes('Macintosh') || process.platform === 'darwin'
        const isWin = !isMac && (cleanUa.includes('Windows') || process.platform === 'win32')
        const navigatorPlatform = resolveNavigatorPlatform(cleanUa)
        const chPlatform = isMac ? 'macOS' : isWin ? 'Windows' : 'Linux'
        const chPlatformVersion = isMac
          ? (cleanUa.match(/Mac OS X ([0-9_]+)/)?.[1]?.replace(/_/g, '.') ?? '10.15.7')
          : isWin
            ? '10.0.0'
            : '6.5.0'
        const architecture = process.arch === 'arm64' ? 'arm' : 'x86'
        await cdp
          .send('Emulation.setUserAgentOverride', {
            userAgent: cleanUa,
            acceptLanguage: hostLang.acceptLanguage,
            platform: navigatorPlatform,
            userAgentMetadata: {
              brands: [
                { brand: 'Not(A:Brand', version: '24' },
                { brand: 'Chromium', version: major },
                { brand: 'Google Chrome', version: major },
              ],
              fullVersionList: [
                { brand: 'Not(A:Brand', version: '24.0.0.0' },
                { brand: 'Chromium', version: fullVersion },
                { brand: 'Google Chrome', version: fullVersion },
              ],
              fullVersion,
              platform: chPlatform,
              platformVersion: chPlatformVersion,
              architecture,
              bitness: '64',
              model: '',
              mobile: false,
              wow64: false,
            },
          })
          .catch(() => undefined)
      }
      cdp.on('Browser.downloadWillBegin', event => {
        let finish = (): void => {}
        const done = new Promise<void>(resolve => {
          finish = resolve
        })
        const notice: DownloadNotice & { finish: () => void } = {
          guid: event.guid,
          url: redactUrl(event.url),
          filename: event.suggestedFilename,
          bytes: null,
          type: docResponses.get(redactUrl(event.url)) ?? null,
          at: Date.now(),
          done,
          finish,
        }
        downloads.count++
        downloads.last = notice
        for (const wake of downloads.waiters.splice(0)) wake()
        capture('download', `the page asked to download ${notice.filename} (${notice.url}) — denied: downloads are not followed here`)
      })
      cdp.on('Browser.downloadProgress', event => {
        const last = downloads.last as (DownloadNotice & { finish: () => void }) | null
        if (!last || last.guid !== event.guid) return
        if (event.totalBytes > 0) last.bytes = event.totalBytes
        if (last.type === null) last.type = docResponses.get(last.url) ?? null
        if (event.state !== 'inProgress') last.finish()
      })
    }
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
      const chromeText = request.failure()?.errorText ?? ''
      const relay = chromeText === 'net::ERR_ABORTED' ? null : relayFailureFor(request.url())
      const errorText = relay === null ? chromeText : `net::${chromeNetErrorFor(relay.code)}`
      if (isMainNavigation(request)) {
        if (errorText === 'net::ERR_ABORTED') navWatch.abortedAt = Date.now()
        else navFailure.last = { url: redactUrl(request.url()), errorText, at: Date.now() }
        settleNav()
      }
      capture('net', `${request.method()} ${redactUrl(request.url())} FAILED ${errorText} (${request.resourceType()})`)
    })
    page.on('response', response => {
      const req = response.request()
      if (isMainNavigation(req)) {
        docResponses.set(redactUrl(response.url()), response.headers()['content-type'] ?? null)
        if (docResponses.size > 32) docResponses.delete(docResponses.keys().next().value!)
      }
      const status = response.status()
      if (status < 400) return
      capture('net', `${req.method()} ${redactUrl(response.url())} ${status} (${req.resourceType()})`)
    })
    page.on('dialog', dialog => {
      const kind = dialog.type()
      const verb = kind === 'beforeunload' ? 'accepted' : 'dismissed'
      const saw = kind === 'confirm' ? ' (the page received false)' : kind === 'prompt' ? ' (the page received null)' : ''
      capture('dialog', `${kind}("${dialog.message()}") auto-${verb}${saw} — the page was blocked on it`)
      void (kind === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {
      })
    })
    if (typeof page.bringToFront === 'function') await page.bringToFront()
    if (state.disposed) {
      return {
        state: 'torn-down',
        note: 'the owner was torn down while its browser launch was in flight — the child was closed, nothing is open',
      }
    }
    state.goneAt = null
    browser.on('disconnected', () => markSessionGone(state, browser))
    state.session = {
      browser,
      page,
      resolution,
      driverVersion: (puppeteerPkg as { version?: string }).version ?? 'bundled',
      consoleRing,
      nav,
      sandboxDowngraded,
      popups,
      navFailure,
      networkRefusal,
      policyBlocks,
      closeNetwork: proxy.close,
      downloads,
      navWatch,
      profileOrigin,
      profileDir,
      headless,
      cursor: { x: 160, y: 120 },
    }
    unhanded = null
  } finally {
    state.launching = false
    armIdleLease(state)
    if (unhanded !== null) await closeChild(unhanded)
    if (state.session === null) {
      state.approvedOrigins.clear()
      state.approvedSecretPairings.clear()
    }
    if (state.session === null) proxyClose?.()
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.on('exit', () => {
      for (const key of ownerStates.owners()) {
        const st = ownerStates.peek(key)
        if (!st?.session) continue
        st.session.closeNetwork()
        killChild(st.session.browser)
        removeTempProfile(st.session.browser)
      }
    })
  }
  return state.session
}

export async function closeBrowserSession(owner: OwnerKey): Promise<boolean> {
  const closed = await closeBrowserSessionDetailed(owner)
  return closed.outcome !== 'none'
}

export async function closeBrowserSessionDetailed(owner: OwnerKey): Promise<{ outcome: CloseOutcome | 'none' }> {
  const state = ownerStates.peek(owner)
  if (!state) return { outcome: 'none' }
  clearIdleLease(state)
  if (state.launchFlight !== null) await state.launchFlight.catch(() => undefined)
  if (!state.session) {
    if (state.goneAt === null) return { outcome: 'none' }
    state.goneAt = null
    return { outcome: 'gone' }
  }
  const session = state.session
  session.closeNetwork()
  const outcome = await closeChild(session.browser)
  state.session = null
  state.goneAt = null
  state.approvedOrigins.clear()
  state.approvedSecretPairings.clear()
  state.checkedActOrigin = null
  clearIdleLease(state)
  return { outcome }
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
