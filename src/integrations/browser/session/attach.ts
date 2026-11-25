import type { Browser as DriverBrowser } from 'puppeteer-core'
import { z } from 'zod/v4'
import { errorMessage } from '../../../platform/errors/errors.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { driverNodeGate } from '../browserResolver.js'
import { type AttachedBrowser, type Hold, type OwnerBrowserState, BROWSER_PROTOCOL_TIMEOUT_MS, EXITED } from './shapes.js'
import { armIdleLease, holdGone, installExitHook, ownerStates, reapDeadHolds } from './owners.js'
import { resolveHostLanguages, resolveHostTimeZone } from './stealth.js'
import { adoptAttachedPage } from './wiring.js'
import { tabsOpenBehindTheOneOnShow } from '../../../platform/host-os/browser.js'

interface AttachEndpoint {
  kind: 'http' | 'ws'
  address: string
}

interface AttachRefusal {
  kind: 'refused'
  refusal: string
}

const ATTACH_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])
const ATTACH_FORMS = 'http://127.0.0.1:<port> or http://localhost:<port>, or the ws:// address under it'
const ATTACH_START = 'start the browser with --remote-debugging-port=<port> and a --user-data-dir of its own'

export function parseAttachEndpoint(raw: string | undefined): AttachEndpoint | AttachRefusal {
  if (raw === undefined || raw.trim() === '') return { kind: 'refused', refusal: `attach requires endpoint: ${ATTACH_FORMS}` }
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch (error) {
    passedOver(error)
    return { kind: 'refused', refusal: `attach refused: "${raw}" is not an address — endpoint is ${ATTACH_FORMS}` }
  }
  const kind = url.protocol === 'http:' ? 'http' : url.protocol === 'ws:' ? 'ws' : null
  if (kind === null) return { kind: 'refused', refusal: `attach refused: a debugging port answers http or ws, not ${url.protocol.slice(0, -1)} — endpoint is ${ATTACH_FORMS}` }
  if (!ATTACH_HOSTS.has(url.hostname)) {
    return { kind: 'refused', refusal: `attach refused: ${url.hostname} is not this machine — a debugging port hands over the whole browser with every signed-in session in it, so Mercury attaches on loopback only: ${ATTACH_FORMS}` }
  }
  if (url.username !== '' || url.password !== '') return { kind: 'refused', refusal: `attach refused: a debugging port takes no credentials — endpoint is ${ATTACH_FORMS}` }
  if (url.port === '') return { kind: 'refused', refusal: `attach refused: "${raw}" names no port — endpoint is ${ATTACH_FORMS}` }
  if (kind === 'http') return { kind, address: url.origin }
  if (!url.pathname.startsWith('/devtools/browser/')) return { kind: 'refused', refusal: `attach refused: the ws:// address of a browser ends in /devtools/browser/<id> — "${raw}" does not` }
  return { kind, address: `ws://${url.host}${url.pathname}` }
}

const versionAnswer = z.object({ webSocketDebuggerUrl: z.string() })

async function browserSocket(endpoint: AttachEndpoint, signal: AbortSignal | undefined): Promise<{ kind: 'socket'; socket: string } | { kind: 'failure'; failure: string }> {
  if (endpoint.kind === 'ws') return { kind: 'socket', socket: endpoint.address }
  let answer: Response
  try {
    answer = await fetch(`${endpoint.address}/json/version`, { redirect: 'error', signal })
  } catch (error) {
    signal?.throwIfAborted()
    return { kind: 'failure', failure: `no browser answers at ${endpoint.address} (${errorMessage(error)}) — ${ATTACH_START}, then attach again` }
  }
  if (answer.status === 404) {
    return { kind: 'failure', failure: `${endpoint.address} answers 404 at /json/version — a Chrome whose remote debugging was turned on at chrome://inspect answers at its ws:// address alone: its endpoint is ws://127.0.0.1:<port>/devtools/browser/<id> (the two lines of the DevToolsActivePort file in its profile folder), or ${ATTACH_START}` }
  }
  if (!answer.ok) return { kind: 'failure', failure: `${endpoint.address} answered HTTP ${answer.status} at /json/version — that is not a browser's debugging port` }
  const version = versionAnswer.safeParse(await answer.json().catch(passedOverAs(null)))
  if (!version.success) return { kind: 'failure', failure: `${endpoint.address} answered /json/version without a webSocketDebuggerUrl — that is not a browser's debugging port` }
  const socket = parseAttachEndpoint(version.data.webSocketDebuggerUrl)
  if (socket.kind !== 'ws' || new URL(socket.address).port !== new URL(endpoint.address).port) {
    return { kind: 'failure', failure: `${endpoint.address} names a WebSocket that is not its own (${version.data.webSocketDebuggerUrl}) — nothing was attached` }
  }
  return { kind: 'socket', socket: socket.address }
}

async function adoptPages(state: OwnerBrowserState, hold: Hold, attached: AttachedBrowser): Promise<number> {
  const pages = (await hold.browser.pages()).filter(page => !page.isClosed())
  await Promise.all(pages.map(page => adoptAttachedPage(state, hold, attached, page).armed))
  return pages.length
}

export async function refreshAttachedTabs(owner: OwnerKey): Promise<void> {
  const state = ownerStates.peek(owner)
  if (!state) return
  for (const hold of [...state.holds]) {
    if (hold.attached !== null && hold.browser.connected) await adoptPages(state, hold, hold.attached).catch(passedOverAs(0))
  }
}

type AttachOutcome = { state: 'attached'; attached: AttachedBrowser } | { state: 'refused'; note: string }

export async function attachBrowserSession(owner: OwnerKey, endpoint: AttachEndpoint, signal?: AbortSignal): Promise<AttachOutcome> {
  const gate = driverNodeGate()
  if (!gate.ok) return { state: 'refused', note: gate.note }
  const state = ownerStates.get(owner)
  if (state.launchFlight !== null) await state.launchFlight.flight.catch(passedOverAs(undefined))
  reapDeadHolds(state)
  for (const hold of state.holds) {
    if (hold.attached === null || !hold.browser.connected || hold.attached.endpoint !== endpoint.address) continue
    await adoptPages(state, hold, hold.attached)
    armIdleLease(state)
    return { state: 'attached', attached: hold.attached }
  }
  if (state.tabs.size > 0 || state.launching) {
    return { state: 'refused', note: `a browser session is open (${[...state.tabs.keys()].join(', ') || 'launching'}) — op:"close" ends it first; an attached browser is never driven beside another` }
  }
  state.launching = true
  let unhanded: DriverBrowser | null = null
  try {
    const found = await browserSocket(endpoint, signal)
    if (found.kind === 'failure') return { state: 'refused', note: found.failure }
    let browser: DriverBrowser
    try {
      browser = await (await import('puppeteer-core')).default.connect({ browserWSEndpoint: found.socket, defaultViewport: null, protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS })
    } catch (error) {
      return { state: 'refused', note: `the browser at ${endpoint.address} did not take the connection (${errorMessage(error)}) — ${ATTACH_START}, then attach again` }
    }
    unhanded = browser
    if (state.disposed) return { state: 'refused', note: 'the owner was torn down while the attach was in flight — nothing is attached' }
    const hostLang = resolveHostLanguages()
    const attached: AttachedBrowser = { endpoint: endpoint.address, product: await browser.version().catch(passedOverAs('')), opened: new Set(), adopted: 0, opensBehind: tabsOpenBehindTheOneOnShow() }
    const hold: Hold = {
      browser,
      attached,
      resolution: { state: 'ok', source: 'attached', label: endpoint.address },
      sandboxDowngraded: false,
      profileOrigin: null,
      profileDir: null,
      headless: false,
      closeNetwork: () => {},
      networkRefusal: { count: 0, last: null },
      relayFailureFor: () => null,
      baseline: { identity: null, languages: hostLang.languages, timeZone: resolveHostTimeZone(), locale: null, headers: null, touch: false },
      tabs: new Set(),
      owned: new Map(),
      births: new Map(),
      died: new Map(),
      creating: 0,
      front: null,
      watch: null,
      birthsAsked: false,
      downloads: null,
      arriving: new Map(),
      unwanted: new Set(),
      launchArrivals: null,
    }
    if ((await adoptPages(state, hold, attached).catch(passedOverAs(0))) === 0) {
      for (const session of hold.tabs) {
        session.left = true
        if (state.tabs.get(session.tab) === session) state.tabs.delete(session.tab)
      }
      return { state: 'refused', note: `the browser at ${endpoint.address} listed no open tab — open one there, then attach again` }
    }
    state.goneAt = null
    browser.on('disconnected', () => holdGone(state, hold, EXITED))
    state.holds.add(hold)
    unhanded = null
    installExitHook()
    return { state: 'attached', attached }
  } finally {
    state.launching = false
    armIdleLease(state)
    if (unhanded !== null) await unhanded.disconnect().catch(passedOverAs(undefined))
  }
}
