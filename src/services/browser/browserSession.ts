
import { chromeNetErrorFor, startMetadataProxy } from './metadataProxy.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Browser as DriverBrowser, CDPSession, Frame, Page, Protocol } from 'puppeteer-core'
import { getMercuryHome } from '../../utils/envUtils.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { parseOwnerKey, type OwnerKey } from '../run/ownerKey.js'
import {
  driverNodeGate,
  resolveBrowser,
  type BrowserResolution,
} from './browserResolver.js'
import { MAIN_TAB, POPUP_SETTLE_MS, FIRST_NAVIGATION_SILENCE_MS, FIRST_NAVIGATION_STARTS, type DownloadHome, isBrowserErrorPage, type Wiring, type Hold, type Birth, type Session, type OwnerBrowserState, BROWSER_PROTOCOL_TIMEOUT_MS, EXITED, MOVE_FAILED, RESTARTED, type EnsureSessionRefusal, type EnsureBrowserSessionOptions, type PageIdentity, type PagePresented, type PageKit } from './session/shapes.js'
import { clearIdleLease, armIdleLease, type CloseOutcome, tempProfileDirOf, tempProfiles, closeChild, closePage, type LaunchDriver, launchDriverForProof, ownerStates, installExitHook, browserSessionCap, liveBrowserSessionCensus, originOf, closeHoldNetwork, noteEnded, endDownloads, sweepDownloads, holdGone, reapDeadHolds, sessionWirings, holdOf, leaveHold } from './session/owners.js'
import { resolveHostLanguages, resolveNavigatorPlatform, resolveHostTimeZone, pageKits, stealthSource, prepareDocuments } from './session/stealth.js'
import { redactUrl, newWiring, listenProtocol, listenDownloads, downloadBegan, downloadMoved, targetIdOf, tabSession, listenPage, downloadInNewTab } from './session/wiring.js'
export type { ConsoleEntry, NavFailure, DownloadNotice, PopupNote, CheckedTarget, EnsureSessionRefusal, EnsureBrowserSessionOptions, PageIdentity, PagePresented, PageKit } from './session/shapes.js'
export { CONSOLE_RING_CAP, CONSOLE_ENTRY_CAP, MAIN_TAB, isBrowserErrorPage, BROWSER_CLOSE_BOUND_MS, BROWSER_FINISH_BOUND_MS, BROWSER_PROTOCOL_TIMEOUT_MS, NAVIGATION_CAP_MS } from './session/shapes.js'
export type { CloseOutcome } from './session/owners.js'
export { beginBrowserActivity, tempProfileDirOf, removeTempProfile, childGone, setBrowserLaunchDriverForProof, disposeBrowserOwner, browserSessionCap, liveBrowserSessionCensus, originOf, noteCheckedActOrigin, consumeCheckedActOrigin, noteEmulatedPage, emulatedPageOf, originApproved, approveWebOrigin, approvedOriginList, activeSession, browserTransfers, browserTabs, endedTab, sessionGoneAt, driverVersion, secretPairingKey, secretPairingApproved, approveSecretPairing } from './session/owners.js'
export { resolveHostLanguages, resolveNavigatorPlatform, pageKitOf } from './session/stealth.js'

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
    const busy = ownerStates.owners().some(other => other !== owner && profileHeld(other, candidate))
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

function profileHeld(owner: OwnerKey, profileDir: string): boolean {
  return [...(ownerStates.peek(owner)?.holds ?? [])].some(hold => hold.browser.connected && hold.profileDir === profileDir)
}

function hintHeaders(identity: PageIdentity): Map<string, string> | null {
  const meta = identity.userAgentMetadata
  if (meta === undefined) return null
  const quoted = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const brands = (list: Array<{ brand: string; version: string }> | undefined): string =>
    (list ?? []).map(entry => `${quoted(entry.brand)};v=${quoted(entry.version)}`).join(', ')
  return new Map([
    ['sec-ch-ua', brands(meta.brands)],
    ['sec-ch-ua-mobile', meta.mobile ? '?1' : '?0'],
    ['sec-ch-ua-platform', quoted(meta.platform)],
    ['sec-ch-ua-platform-version', quoted(meta.platformVersion)],
    ['sec-ch-ua-arch', quoted(meta.architecture)],
    ['sec-ch-ua-bitness', quoted(meta.bitness ?? '')],
    ['sec-ch-ua-model', quoted(meta.model)],
    ['sec-ch-ua-full-version', quoted(meta.fullVersion ?? '')],
    ['sec-ch-ua-full-version-list', brands(meta.fullVersionList)],
    ['sec-ch-ua-wow64', meta.wow64 ? '?1' : '?0'],
  ])
}

function observeFirstRequest(kit: PageKit, presented: PagePresented, targetId: string): void {
  const cdp = kit.cdp!
  let first: string | null = null
  const early = new Map<string, Protocol.Network.Headers>()
  const inspect = (headers: Protocol.Network.Headers): void => {
    const identity = (kit.presented ?? presented).identity
    if (identity !== null) {
      const sent = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]))
      const hints = hintHeaders(identity)
      kit.firstRequestUnarmed = sent.get('user-agent') !== identity.userAgent ||
        [...sent].some(([name, value]) => name.startsWith('sec-ch-ua') && (hints === null || (hints.has(name) && hints.get(name) !== value)))
    }
    cdp.off('Network.requestWillBeSent', onRequest)
    cdp.off('Network.requestWillBeSentExtraInfo', onHeaders)
    early.clear()
  }
  const onRequest = (event: Protocol.Network.RequestWillBeSentEvent): void => {
    if (first !== null || event.type !== 'Document' || event.frameId !== targetId) return
    first = event.requestId
    const headers = early.get(first)
    if (headers !== undefined) inspect(headers)
  }
  const onHeaders = (event: Protocol.Network.RequestWillBeSentExtraInfoEvent): void => {
    if (event.requestId === first) inspect(event.headers)
    else if (first === null) early.set(event.requestId, event.headers)
  }
  cdp.on('Network.requestWillBeSent', onRequest)
  cdp.on('Network.requestWillBeSentExtraInfo', onHeaders)
}

const FIRST_HINTS = ['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']

function takesHints(url: string): boolean {
  let host: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    if (parsed.protocol !== 'http:') return false
    host = parsed.hostname.replace(/\.$/, '')
  } catch {
    return false
  }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d+){3}$/.test(host) || host === '[::1]'
}

function mendFirstRequest(birth: Birth, identity: PageIdentity, own: Record<string, string> | null): void {
  const { cdp, kit } = birth
  const hints = hintHeaders(identity)
  let armed = own !== null
  const disarm = (): void => {
    if (!armed) return
    armed = false
    void cdp.send('Network.setExtraHTTPHeaders', { headers: own ?? {} }).catch(() => undefined)
  }
  const onRequest = (event: Protocol.Fetch.RequestPausedEvent): void => {
    if (event.request.method !== 'GET') birth.posted = true
    const stray = armed && !takesHints(event.request.url)
    disarm()
    let moved = false
    const headers: Protocol.Fetch.HeaderEntry[] = []
    for (const [name, value] of Object.entries(event.request.headers)) {
      const hint = name.toLowerCase()
      const wanted = !hint.startsWith('sec-ch-ua') ? value : hints === null || (stray && FIRST_HINTS.includes(hint)) ? null : (hints.get(hint) ?? value)
      if (wanted !== value) moved = true
      if (wanted !== null) headers.push({ name, value: wanted })
    }
    void cdp.send('Fetch.continueRequest', { requestId: event.requestId, ...(moved ? { headers } : {}) }).catch(() => undefined)
  }
  const onCommit = (event: Protocol.Page.FrameNavigatedEvent): void => {
    if (event.frame.parentId !== undefined) return
    disarm()
    cdp.off('Fetch.requestPaused', onRequest)
    cdp.off('Page.frameNavigated', onCommit)
    if (!kit.fetchHeld) void cdp.send('Fetch.disable').catch(() => undefined)
  }
  cdp.on('Fetch.requestPaused', onRequest)
  cdp.on('Page.frameNavigated', onCommit)
  void cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }).catch(() => undefined)
}

function observeBirthNavigation(hold: Hold, wiring: Wiring, cdp: CDPSession, targetId: string): () => void {
  const requests = new Map<string, { method: string; url: string }>()
  const onRequest = (event: Protocol.Network.RequestWillBeSentEvent): void => {
    if (event.type !== 'Document' || event.frameId !== targetId) return
    requests.set(event.requestId, { method: event.request.method, url: event.request.url })
    if (requests.size > 16) requests.delete(requests.keys().next().value!)
  }
  const onFailed = (event: Protocol.Network.LoadingFailedEvent): void => {
    const entry = requests.get(event.requestId)
    requests.delete(event.requestId)
    if (entry === undefined) return
    const chromeText = event.errorText
    const relay = chromeText === 'net::ERR_ABORTED' ? null : hold.relayFailureFor(entry.url)
    const errorText = relay === null ? chromeText : `net::${chromeNetErrorFor(relay.code)}`
    if (errorText === 'net::ERR_ABORTED') wiring.navWatch.abortedAt = Date.now()
    else wiring.navFailure.last = { url: redactUrl(entry.url), errorText, at: Date.now() }
    wiring.capture('net', `${entry.method} ${redactUrl(entry.url)} FAILED ${errorText} (document)`)
  }
  const onNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
    if (event.frame.parentId !== undefined) return
    wiring.nav.seq++
    if (/^https?:/i.test(event.frame.url)) wiring.nav.web++
    if (!isBrowserErrorPage(event.frame.url)) wiring.navFailure.last = null
    wiring.capture('nav', `navigated to ${redactUrl(event.frame.url)}`)
  }
  cdp.on('Network.requestWillBeSent', onRequest)
  cdp.on('Network.loadingFailed', onFailed)
  cdp.on('Page.frameNavigated', onNavigated)
  let released = false
  return () => {
    if (released) return
    released = true
    cdp.off('Network.requestWillBeSent', onRequest)
    cdp.off('Network.loadingFailed', onFailed)
    cdp.off('Page.frameNavigated', onNavigated)
    requests.clear()
  }
}

function presentedOf(kit: PageKit): PagePresented {
  return kit.presented ?? kit.born ?? { identity: kit.identity, languages: kit.languages, timeZone: kit.timeZone, locale: null, headers: null, touch: false }
}

function presentToFrame(frame: CDPSession, kit: PageKit, born: boolean): void {
  const { identity, touch } = presentedOf(kit)
  const quiet = (): undefined => undefined
  if (identity !== null) void frame.send('Emulation.setUserAgentOverride', identity).catch(quiet)
  if (touch || !born) void frame.send('Emulation.setTouchEmulationEnabled', { enabled: touch }).catch(quiet)
}

export function presentToFrames(kit: PageKit): void {
  for (const frame of kit.frames?.values() ?? []) presentToFrame(frame.session, kit, false)
}

export function sessionOfFrame(page: Page, frame: Frame): CDPSession | null {
  const kit = pageKits.get(page)
  if (kit === undefined) return null
  for (let at: Frame | null = frame; at !== null; at = at.parentFrame()) {
    const id = (at as { _id?: string })._id
    for (const held of kit.frames?.values() ?? []) if (held.target === id) return held.session
  }
  return kit.cdp
}

function watchFrames(kit: PageKit, parent: CDPSession): Promise<void> {
  const frames = (kit.frames ??= new Map<string, { session: CDPSession; parent: string; target: string }>())
  const quiet = (): undefined => undefined
  parent.on('Target.attachedToTarget', event => {
    const frame = parent.connection()?.session(event.sessionId) ?? null
    if (frame === null) {
      void parent.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(quiet)
      return
    }
    const letGo = (): void => {
      void parent.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(quiet)
    }
    try {
      if (event.targetInfo.type !== 'iframe') {
        letGo()
        return
      }
      frames.set(event.sessionId, { session: frame, parent: parent.id(), target: event.targetInfo.targetId })
      try {
        presentToFrame(frame, kit, true)
      } catch {}
      void frame.send('Page.enable').catch(quiet)
      void frame.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource(presentedOf(kit).languages) }).catch(quiet)
      void watchFrames(kit, frame)
    } catch {
    } finally {
      try {
        void frame.send('Runtime.runIfWaitingForDebugger').catch(letGo)
      } catch {
        letGo()
      }
    }
  })
  parent.on('Target.detachedFromTarget', event => {
    const gone = [event.sessionId]
    for (let id = gone.pop(); id !== undefined; id = gone.pop()) {
      frames.delete(id)
      for (const [inner, held] of frames) if (held.parent === id) gone.push(inner)
    }
  })
  return parent
    .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }] })
    .catch(quiet)
}

function bornPage(hold: Hold, cdp: CDPSession, info: Protocol.Target.TargetInfo): void {
  const opener = info.openerId === undefined ? null : (hold.owned.get(info.openerId) ?? null)
  const inherited = opener === null ? null : (pageKits.get(opener.page)?.presented ?? null)
  const presented = inherited ?? hold.baseline
  const quiet = (): undefined => undefined
  const kit: PageKit = { cdp, identity: hold.baseline.identity, languages: hold.baseline.languages, timeZone: hold.baseline.timeZone, presented: null, born: inherited, fetchHeld: false, late: null }
  let settle = (): void => {}
  const settled = new Promise<void>(resolve => {
    settle = resolve
  })
  const wiring = newWiring()
  const handover = observeBirthNavigation(hold, wiring, cdp, info.targetId)
  const birth: Birth = { cdp, kit, wiring, opener, keep: opener !== null && opener.acting > 0, posted: false, handover, settled, settle }
  const opening = opener === null ? null : opener.opening
  if (opener !== null) opener.opening = null
  const hints = presented.identity === null || opening === null || !takesHints(opening) ? null : hintHeaders(presented.identity)
  const armed = hints === null ? null : Object.fromEntries(FIRST_HINTS.map(name => [name, hints.get(name) ?? '']))
  if (presented.identity !== null) void cdp.send('Emulation.setUserAgentOverride', presented.identity).catch(quiet)
  void cdp.send('Emulation.setTimezoneOverride', { timezoneId: presented.timeZone }).catch(quiet)
  if (presented.locale !== null) void cdp.send('Emulation.setLocaleOverride', { locale: presented.locale }).catch(quiet)
  void cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(quiet)
  void cdp.send('Page.enable').catch(quiet)
  void cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource(presented.languages) }).catch(quiet)
  void cdp.send('Network.enable').catch(quiet)
  if (presented.headers !== null || armed !== null) void cdp.send('Network.setExtraHTTPHeaders', { headers: { ...armed, ...presented.headers } }).catch(quiet)
  if (hold.downloads === null) {
    void cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(quiet)
    listenDownloads(birth.wiring, cdp)
  }
  listenProtocol(birth.wiring, cdp)
  observeFirstRequest(kit, presented, info.targetId)
  if (info.openerId !== undefined && presented.identity !== null) mendFirstRequest(birth, presented.identity, armed === null ? null : (presented.headers ?? {}))
  void watchFrames(kit, cdp)
  void cdp.send('Runtime.runIfWaitingForDebugger').catch(quiet)
  if (info.openerId !== undefined && opener === null) {
    handover()
    void hold.watch?.send('Target.closeTarget', { targetId: info.targetId }).catch(quiet)
    return
  }
  hold.births.set(info.targetId, birth)
  if (opener !== null && birth.keep) {
    for (const wake of opener.popups.waiters.splice(0)) wake()
  }
}

async function watchBirths(state: OwnerBrowserState, hold: Hold, downloads: DownloadHome | undefined): Promise<void> {
  const browser = hold.browser
  if (typeof browser.target !== 'function') return
  const watch = await browser.target().createCDPSession().catch(() => null)
  if (watch === null) return
  watch.on('Target.attachedToTarget', event => {
    const child = watch.connection()?.session(event.sessionId) ?? null
    if (child === null) return
    if (!event.waitingForDebugger) {
      void watch.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(() => undefined)
      return
    }
    bornPage(hold, child, event.targetInfo)
  })
  watch.on('Target.detachedFromTarget', event => {
    for (const [id, birth] of hold.births) {
      if (birth.cdp.id() !== event.sessionId) continue
      hold.births.delete(id)
      birth.handover()
      const download = hold.downloads === null ? birth.wiring.downloads.last : null
      const wiring = birth.opener === null ? undefined : sessionWirings.get(birth.opener)
      if (download !== null && wiring !== undefined) downloadInNewTab(wiring, download)
      if (hold.downloads === null || !birth.keep) {
        birth.settle()
        continue
      }
      hold.died.set(id, birth)
      const forget = setTimeout(() => {
        hold.died.delete(id)
        birth.settle()
      }, 250)
      forget.unref?.()
    }
  })
  hold.watch = watch
  const armed = await watch
    .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }] })
    .then(() => true, () => false)
  if (!armed) {
    hold.watch = null
    return
  }
  if (downloads === undefined) return
  watch.on('Browser.downloadWillBegin', event => downloadBegan(state, hold, event))
  watch.on('Browser.downloadProgress', event => downloadMoved(state, hold, event))
  const followed = await watch
    .send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: path.join(downloads.home, 'incoming'), eventsEnabled: true })
    .then(() => true, () => false)
  if (followed) hold.downloads = downloads
}

function leftForHost(origins: Set<string>, url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return true
  }
  for (const origin of origins) {
    try {
      if (new URL(origin).hostname === host) return true
    } catch {
      continue
    }
  }
  return false
}

export async function firstNavigation<T>(session: Session, url: string, go: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const hold = holdOf(session)
  const arrivals = hold.launchArrivals
  hold.launchArrivals = null
  if (arrivals === null || arrivals.origins === null) return go()
  const origins = arrivals.origins
  if (!arrivals.madeProfile) {
    arrivals.origins = null
    return go()
  }
  const pagesBefore = session.nav.web
  const downloadsBefore = session.downloads.count
  const underWay = (): boolean => session.nav.web > pagesBefore || session.downloads.count > downloadsBefore || leftForHost(origins, url)
  const web = /^https?:/i.test(url)
  const stopped = (): boolean => signal?.aborted === true
  const halted = (): unknown => {
    void pageKits.get(session.page)?.cdp?.send('Page.stopLoading').catch(() => undefined)
    return abortReason(signal as AbortSignal)
  }
  const quiet = (until: number | null): { over: Promise<null>; end: () => void } => {
    let end = (): void => {}
    const over = new Promise<null>(resolve => {
      if (stopped()) {
        resolve(null)
        return
      }
      const bound = until === null ? undefined : setTimeout(() => resolve(null), Math.max(0, until - Date.now()))
      const onAbort = (): void => resolve(null)
      signal?.addEventListener('abort', onAbort, { once: true })
      end = () => {
        clearTimeout(bound)
        signal?.removeEventListener('abort', onAbort)
      }
    })
    return { over, end }
  }
  try {
    let startedAt = Date.now()
    let attempt = go()
    for (let starts = 1; ; starts++) {
      const last = starts >= FIRST_NAVIGATION_STARTS
      const settled = attempt.then(
        (value): { value: T } | { error: unknown } => ({ value }),
        (error: unknown): { value: T } | { error: unknown } => ({ error }),
      )
      const ended = (until: number | null): Promise<{ value: T } | { error: unknown } | null> => {
        const wait = quiet(until)
        return Promise.race([settled, wait.over]).finally(wait.end)
      }
      let outcome = await ended(web && !last ? startedAt + FIRST_NAVIGATION_SILENCE_MS : null)
      if (outcome === null && !stopped() && underWay()) outcome = await ended(null)
      if (outcome === null) {
        if (stopped()) throw halted()
      } else if ('value' in outcome) {
        return outcome.value
      } else {
        if (stopped()) throw halted()
        if (last || !/net::ERR_ABORTED/.test((outcome.error as Error | undefined)?.message ?? '') || underWay()) throw outcome.error
        if (starts > 1) {
          const gap = quiet(startedAt + FIRST_NAVIGATION_SILENCE_MS)
          await gap.over.finally(gap.end)
          if (stopped()) throw halted()
          if (underWay()) throw outcome.error
        }
      }
      startedAt = Date.now()
      attempt = go()
    }
  } finally {
    arrivals.origins = null
  }
}

export function popupInFlight(session: Session): boolean {
  const hold = holdOf(session)
  return [...hold.births.values(), ...hold.died.values()].some(birth => birth.opener === session && birth.keep)
}

export async function popupsSettled(session: Session): Promise<void> {
  const deadline = Date.now() + POPUP_SETTLE_MS
  for (;;) {
    const hold = holdOf(session)
    const pending = [...hold.births.values(), ...hold.died.values()].filter(birth => birth.opener === session && birth.keep)
    const left = deadline - Date.now()
    if (pending.length === 0 || left <= 0) return
    let bound: ReturnType<typeof setTimeout> | undefined
    const lapse = new Promise<void>(resolve => {
      bound = setTimeout(resolve, left)
    })
    await Promise.race([Promise.all(pending.map(birth => birth.settled)), lapse])
    if (bound !== undefined) clearTimeout(bound)
  }
}

export async function bringTabToFront(session: Session): Promise<void> {
  const hold = holdOf(session)
  if (hold.front === session) return
  if (typeof session.page.bringToFront === 'function') await session.page.bringToFront().catch(() => undefined)
  hold.front = session
}

async function armLate(page: Page, baseline: PagePresented, deny: boolean, births: boolean): Promise<PageKit> {
  const kit: PageKit = { cdp: null, identity: baseline.identity, languages: baseline.languages, timeZone: baseline.timeZone, presented: null, born: null, fetchHeld: false }
  const cdp = typeof page.createCDPSession === 'function' ? await page.createCDPSession().catch(() => null) : null
  kit.cdp = cdp
  await prepareDocuments(page, births ? cdp : null, baseline.languages)
  if (cdp !== null) {
    await cdp.send('Network.enable').catch(() => undefined)
    if (deny) await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined)
    await cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(() => undefined)
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: baseline.timeZone }).catch(() => undefined)
    if (baseline.identity !== null) await cdp.send('Emulation.setUserAgentOverride', baseline.identity).catch(() => undefined)
    if (births) await watchFrames(kit, cdp)
  }
  return kit
}

async function newHoldPage(hold: Hold): Promise<{ page: Page; wiring: Wiring }> {
  hold.creating++
  try {
    const page = await hold.browser.newPage()
    try {
      const id = targetIdOf(page)
      const born = id === null ? undefined : hold.births.get(id)
      if (born !== undefined && id !== null) {
        hold.births.delete(id)
        born.handover()
        pageKits.set(page, born.kit)
        return { page, wiring: born.wiring }
      }
      const wiring = newWiring()
      const kit = await armLate(page, hold.baseline, hold.downloads === null, hold.birthsAsked)
      if (kit.cdp !== null) {
        listenProtocol(wiring, kit.cdp)
        if (hold.downloads === null) listenDownloads(wiring, kit.cdp)
      }
      pageKits.set(page, kit)
      return { page, wiring }
    } catch (err) {
      await closePage(page)
      throw err
    }
  } finally {
    hold.creating--
  }
}

export async function ensureBrowserSession(
  owner: OwnerKey,
  opts: EnsureBrowserSessionOptions = {},
): Promise<Session | EnsureSessionRefusal> {
  const state = ownerStates.get(owner)
  const tab = opts.tab ?? MAIN_TAB
  const wantedOrigin = opts.origin && opts.origin.startsWith('http') ? originOf(opts.origin) : null
  for (;;) {
    const held = state.tabs.get(tab)
    if (held && held.browser.connected) {
      const sameHeadless = opts.headless === undefined || held.headless === opts.headless
      const sameOrigin = wantedOrigin === null || held.profileOrigin === wantedOrigin
      if (sameHeadless && sameOrigin) {
        armIdleLease(state)
        return held
      }
    }
    const inFlight = state.launchFlight
    if (inFlight === null) break
    if (inFlight.tab === tab) return awaitLaunch(inFlight.flight, opts.signal)
    await awaitLaunch(
      inFlight.flight.then(() => undefined, () => undefined),
      opts.signal,
    )
  }
  const flight = placeTab(owner, state, tab, opts)
  const entry = { tab, flight }
  state.launchFlight = entry
  const clear = (): void => {
    if (state.launchFlight === entry) state.launchFlight = null
  }
  void flight.then(clear, clear)
  return awaitLaunch(flight, opts.signal)
}

function awaitLaunch<T>(flight: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

async function placeTab(
  owner: OwnerKey,
  state: OwnerBrowserState,
  tab: string,
  opts: EnsureBrowserSessionOptions = {},
): Promise<Session | EnsureSessionRefusal> {
  reapDeadHolds(state)
  const gate = driverNodeGate()
  if (!gate.ok) return { state: 'unavailable', note: gate.note }
  const profileOrigin = opts.origin && opts.origin.startsWith('http') ? originOf(opts.origin) : null
  const headless = opts.headless ?? true
  const home =
    [...state.holds].find(hold => hold.browser.connected && hold.profileOrigin === profileOrigin && hold.headless === headless) ?? null
  let resolution: BrowserResolution | null = null
  if (home === null) {
    const cap = browserSessionCap()
    const identity = parseOwnerKey(owner)
    const others = liveBrowserSessionCensus().filter(row => {
      if (row.owner === owner) return false
      const other = parseOwnerKey(row.owner)
      return other.workspace === identity.workspace && other.sessionId === identity.sessionId && other.lane !== 'main'
    })
    if (cap !== null && identity.lane !== 'main' && others.length >= cap) {
      const lanes = others.map(row => row.lane).join(', ')
      return {
        state: 'at-capacity',
        note: `${others.length} of ${cap} child browser sessions are live in this parent session (${lanes}); the lead has a separate slot. Close a finished session with op:"close", wait for its 5-minute idle lease to expire, or raise MERCURY_BROWSER_MAX_SESSIONS.`,
      }
    }
    const found = resolveBrowser()
    if (found.state === 'unavailable') {
      return { state: 'unavailable', note: `${found.note} — ${found.remedies.join('; ')}` }
    }
    resolution = found
  }
  const moving = state.tabs.get(tab) ?? null
  if (moving !== null) state.tabs.delete(tab)
  state.launching = true
  let unhanded: DriverBrowser | null = null
  let stray: Page | null = null
  let proxyClose: (() => void) | undefined
  let landed: Session | null = null
  try {
    if (moving !== null) await leaveHold(state, moving, true)
    let hold: Hold
    let page: Page
    let wiring: Wiring
    if (home !== null) {
      hold = home
      const made = await newHoldPage(hold)
      page = made.page
      wiring = made.wiring
      stray = page
    } else {
      const networkRefusal: Hold['networkRefusal'] = { count: 0, last: null }
      const relayFailures = new Map<string, { code: string; at: number }>()
      const relayFailureFor = (url: string): { code: string; at: number } | null => {
        let origin = ''
        try { origin = new URL(url).origin } catch { return null }
        const hit = relayFailures.get(url) ?? relayFailures.get(origin)
        if (hit === undefined || Date.now() - hit.at > 15_000) return null
        return hit
      }
      const launchArrivals: NonNullable<Hold['launchArrivals']> = { origins: new Set(), madeProfile: false }
      const proxy = await startMetadataProxy(
        reason => { networkRefusal.last = reason; networkRefusal.count++ },
        (target, code) => {
          relayFailures.set(target, { code, at: Date.now() })
          if (relayFailures.size > 32) relayFailures.delete(relayFailures.keys().next().value!)
        },
        origin => { launchArrivals.origins?.add(origin) },
      )
      proxyClose = proxy.close
      const launch: LaunchDriver =
        launchDriverForProof ?? (async options => (await import('puppeteer-core')).default.launch(options))
      const hostLang = resolveHostLanguages()
      const hostTimeZone = resolveHostTimeZone()
      const profileDir = profileOrigin ? browserProfileDirForOrigin(profileOrigin, owner) : null
      launchArrivals.madeProfile = profileDir === null || !fs.existsSync(profileDir)
      if (profileDir) {
        for (const other of [...state.holds]) {
          if (other.profileDir !== profileDir) continue
          const browser = other.browser
          holdGone(state, other, RESTARTED)
          await closeChild(browser)
        }
      }
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
        const heldElsewhere = ownerStates.owners().some(other => other !== owner && profileHeld(other, profileDir))
        if (!heldElsewhere) {
          for (const lockName of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            try {
              fs.rmSync(path.join(profileDir, lockName), { force: true })
            } catch {}
          }
          for (const earlier of ['Sessions', 'Sessions_Encrypted', 'Current Session', 'Current Tabs', 'Last Session', 'Last Tabs', ...(opts.downloads === undefined ? [] : ['History', 'History-journal', 'History-wal', 'History-shm'])]) {
            try {
              fs.rmSync(path.join(profileDir, 'Default', earlier), { recursive: true, force: true })
            } catch {}
          }
        }
      }
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
        executablePath: resolution!.executablePath,
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
      const temp = tempProfileDirOf(browser)
      if (temp !== null) {
        tempProfiles.set(temp, browser)
        installExitHook()
      }
      const pages = await browser.pages()
      page = pages[0] ?? (await browser.newPage())
      const kit: PageKit = { cdp: null, identity: null, languages: hostLang.languages, timeZone: hostTimeZone, presented: null, born: null, fetchHeld: false }
      wiring = newWiring()
      const cdp =
        typeof page.createCDPSession === 'function' ? await page.createCDPSession().catch(() => null) : null
      kit.cdp = cdp
      await prepareDocuments(page, opts.births === true ? cdp : null, hostLang.languages)
      pageKits.set(page, kit)
      if (cdp !== null) {
        await cdp.send('Network.enable').catch(() => undefined)
        listenProtocol(wiring, cdp)
        if (opts.downloads === undefined || opts.births !== true) await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined)
        await cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(() => undefined)
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: hostTimeZone }).catch(() => undefined)
        const rawUa = typeof browser.userAgent === 'function' ? await browser.userAgent().catch(() => '') : ''
        const cleanUa = rawUa.replace(/HeadlessChrome\//g, 'Chrome/')
        if (cleanUa) {
          const versionStr = typeof browser.version === 'function' ? await browser.version().catch(() => '') : ''
          const fullVersion =
            resolution!.buildId ??
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
          kit.identity = {
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
          }
          await cdp.send('Emulation.setUserAgentOverride', kit.identity).catch(() => undefined)
        }
      }
      hold = {
        browser,
        resolution: resolution!,
        sandboxDowngraded,
        profileOrigin,
        profileDir,
        headless,
        closeNetwork: proxy.close,
        networkRefusal,
        relayFailureFor,
        baseline: { identity: kit.identity, languages: hostLang.languages, timeZone: hostTimeZone, locale: null, headers: null, touch: false },
        tabs: new Set(),
        owned: new Map(),
        births: new Map(),
        died: new Map(),
        creating: 0,
        front: null,
        watch: null,
        birthsAsked: opts.births === true,
        downloads: null,
        arriving: new Map(),
        unwanted: new Set(),
        launchArrivals,
      }
    }
    const session = tabSession(state, hold, tab, page, wiring)
    listenPage(state, session, wiring)
    if (home === null) {
      if (typeof page.bringToFront === 'function') await page.bringToFront()
      if (opts.births === true) await watchBirths(state, hold, opts.downloads)
      const own = pageKits.get(page)?.cdp ?? null
      if (opts.births === true && own !== null) await watchFrames(pageKits.get(page)!, own)
      if (hold.downloads === null && own !== null) {
        if (opts.downloads !== undefined && opts.births === true) await own.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(() => undefined)
        listenDownloads(wiring, own)
      }
    }
    if (state.disposed) {
      return {
        state: 'torn-down',
        note: 'the owner was torn down while its browser launch was in flight — the child was closed, nothing is open',
      }
    }
    state.goneAt = null
    if (home === null) {
      const browser = hold.browser
      browser.on('disconnected', () => holdGone(state, hold, EXITED))
      state.holds.add(hold)
    }
    hold.tabs.add(session)
    hold.front = session
    state.tabs.set(tab, session)
    state.ended.delete(tab)
    landed = session
    unhanded = null
    stray = null
  } finally {
    state.launching = false
    armIdleLease(state)
    if (unhanded !== null) await closeChild(unhanded)
    if (stray !== null) await closePage(stray)
    if (landed === null && moving !== null && state.tabs.size > 0) noteEnded(state, tab, MOVE_FAILED)
    if (state.tabs.size === 0) {
      state.approvedOrigins.clear()
      state.approvedSecretPairings.clear()
    }
    if (landed === null) proxyClose?.()
  }
  installExitHook()
  return landed
}

export async function closeBrowserSession(owner: OwnerKey): Promise<boolean> {
  const closed = await closeBrowserSessionDetailed(owner)
  return closed.outcome !== 'none'
}

export async function closeBrowserSessionDetailed(
  owner: OwnerKey,
  tab?: string,
): Promise<{ outcome: CloseOutcome | 'none'; closed: string[]; open: string[] }> {
  const state = ownerStates.peek(owner)
  if (!state) return { outcome: 'none', closed: [], open: [] }
  clearIdleLease(state)
  if (state.launchFlight !== null) await state.launchFlight.flight.catch(() => undefined)
  if (tab === undefined) state.emulated.clear()
  else state.emulated.delete(tab)
  if (tab !== undefined && state.tabs.size > 0) {
    const session = state.tabs.get(tab)
    if (session === undefined || state.tabs.size > 1) {
      if (session !== undefined) {
        state.tabs.delete(tab)
        state.ended.delete(tab)
      }
      const outcome = session === undefined ? 'none' : await leaveHold(state, session)
      armIdleLease(state)
      return { outcome, closed: session === undefined ? [] : [tab], open: [...state.tabs.keys()] }
    }
  }
  if (state.tabs.size === 0) {
    if (state.goneAt === null) return { outcome: 'none', closed: [], open: [] }
    state.goneAt = null
    return { outcome: 'gone', closed: [], open: [] }
  }
  const closed = [...state.tabs.keys()]
  const holds = [...state.holds]
  for (const session of state.tabs.values()) session.left = true
  for (const hold of holds) {
    closeHoldNetwork(hold)
    endDownloads(state, hold)
  }
  const outcomes = await Promise.all(holds.map(hold => closeChild(hold.browser)))
  state.tabs.clear()
  state.holds.clear()
  await Promise.all(holds.map(hold => sweepDownloads(state, hold)))
  state.ended.clear()
  state.emulated.clear()
  state.popups = 0
  state.goneAt = null
  state.approvedOrigins.clear()
  state.approvedSecretPairings.clear()
  state.checkedActOrigin = null
  clearIdleLease(state)
  return { outcome: outcomes.includes('killed') ? 'killed' : outcomes.includes('unfinished') ? 'unfinished' : outcomes.includes('closed') ? 'closed' : 'gone', closed, open: [] }
}

export function screenshotPath(label: string): string {
  const dir = path.join(getMercuryHome(), 'browser-shots')
  fs.mkdirSync(dir, { recursive: true })
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'shot'
  return path.join(dir, `${Date.now()}-${safe}.png`)
}
