import { chromeNetErrorFor } from '../metadataProxy.js'
import * as path from 'node:path'
import type { CDPSession, Frame, Page, Protocol } from 'puppeteer-core'
import { type DownloadHome, isBrowserErrorPage, type Wiring, type Hold, type Birth, type OwnerBrowserState, type PageIdentity, type PagePresented, type PageKit } from './shapes.js'
import { sessionWirings } from './owners.js'
import { pageKits, stealthSource } from './stealth.js'
import { redactUrl, newWiring, listenProtocol, listenDownloads, downloadBegan, downloadMoved, downloadInNewTab } from './wiring.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { startTimeout } from '../../../platform/async/timers.js'

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
  } catch (error) {
    passedOver(error)
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
    void cdp.send('Network.setExtraHTTPHeaders', { headers: own ?? {} }).catch(passedOverAs(undefined))
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
    void cdp.send('Fetch.continueRequest', { requestId: event.requestId, ...(moved ? { headers } : {}) }).catch(passedOverAs(undefined))
  }
  const onCommit = (event: Protocol.Page.FrameNavigatedEvent): void => {
    if (event.frame.parentId !== undefined) return
    disarm()
    cdp.off('Fetch.requestPaused', onRequest)
    cdp.off('Page.frameNavigated', onCommit)
    if (!kit.fetchHeld) void cdp.send('Fetch.disable').catch(passedOverAs(undefined))
  }
  cdp.on('Fetch.requestPaused', onRequest)
  cdp.on('Page.frameNavigated', onCommit)
  void cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }).catch(passedOverAs(undefined))
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
  if (identity !== null) void frame.send('Emulation.setUserAgentOverride', identity).catch(error => { passedOver(error); return quiet() })
  if (touch || !born) void frame.send('Emulation.setTouchEmulationEnabled', { enabled: touch }).catch(error => { passedOver(error); return quiet() })
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

export function watchFrames(kit: PageKit, parent: CDPSession): Promise<void> {
  const frames = (kit.frames ??= new Map<string, { session: CDPSession; parent: string; target: string }>())
  const quiet = (): undefined => undefined
  parent.on('Target.attachedToTarget', event => {
    const frame = parent.connection()?.session(event.sessionId) ?? null
    if (frame === null) {
      void parent.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(error => { passedOver(error); return quiet() })
      return
    }
    const letGo = (): void => {
      void parent.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(error => { passedOver(error); return quiet() })
    }
    try {
      if (event.targetInfo.type !== 'iframe') {
        letGo()
        return
      }
      frames.set(event.sessionId, { session: frame, parent: parent.id(), target: event.targetInfo.targetId })
      try {
        presentToFrame(frame, kit, true)
      } catch (error) { passedOver(error) }
      void frame.send('Page.enable').catch(error => { passedOver(error); return quiet() })
      void frame.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource(presentedOf(kit).languages) }).catch(error => { passedOver(error); return quiet() })
      void watchFrames(kit, frame)
    } catch (error) {
      passedOver(error)
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
    .catch(error => { passedOver(error); return quiet() })
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
  if (presented.identity !== null) void cdp.send('Emulation.setUserAgentOverride', presented.identity).catch(error => { passedOver(error); return quiet() })
  void cdp.send('Emulation.setTimezoneOverride', { timezoneId: presented.timeZone }).catch(error => { passedOver(error); return quiet() })
  if (presented.locale !== null) void cdp.send('Emulation.setLocaleOverride', { locale: presented.locale }).catch(error => { passedOver(error); return quiet() })
  void cdp.send('Emulation.setAutomationOverride', { enabled: false }).catch(error => { passedOver(error); return quiet() })
  void cdp.send('Page.enable').catch(error => { passedOver(error); return quiet() })
  void cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stealthSource(presented.languages) }).catch(error => { passedOver(error); return quiet() })
  void cdp.send('Network.enable').catch(error => { passedOver(error); return quiet() })
  if (presented.headers !== null || armed !== null) void cdp.send('Network.setExtraHTTPHeaders', { headers: { ...armed, ...presented.headers } }).catch(error => { passedOver(error); return quiet() })
  if (hold.downloads === null) {
    void cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true }).catch(error => { passedOver(error); return quiet() })
    listenDownloads(birth.wiring, cdp)
  }
  listenProtocol(birth.wiring, cdp)
  observeFirstRequest(kit, presented, info.targetId)
  if (info.openerId !== undefined && presented.identity !== null) mendFirstRequest(birth, presented.identity, armed === null ? null : (presented.headers ?? {}))
  void watchFrames(kit, cdp)
  void cdp.send('Runtime.runIfWaitingForDebugger').catch(error => { passedOver(error); return quiet() })
  if (info.openerId !== undefined && opener === null) {
    handover()
    void hold.watch?.send('Target.closeTarget', { targetId: info.targetId }).catch(error => { passedOver(error); return quiet() })
    return
  }
  hold.births.set(info.targetId, birth)
  if (opener !== null && birth.keep) {
    for (const wake of opener.popups.waiters.splice(0)) wake()
  }
}

export async function watchBirths(state: OwnerBrowserState, hold: Hold, downloads: DownloadHome | undefined): Promise<void> {
  const browser = hold.browser
  if (typeof browser.target !== 'function') return
  const watch = await browser.target().createCDPSession().catch(passedOverAs(null))
  if (watch === null) return
  watch.on('Target.attachedToTarget', event => {
    const child = watch.connection()?.session(event.sessionId) ?? null
    if (child === null) return
    if (!event.waitingForDebugger) {
      void watch.send('Target.detachFromTarget', { sessionId: event.sessionId }).catch(passedOverAs(undefined))
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
      const forget = startTimeout(() => {
        hold.died.delete(id)
        birth.settle()
      }, 250)
      forget.unref?.()
    }
  })
  hold.watch = watch
  const armed = await watch
    .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }] })
    .then(() => true, passedOverAs(false))
  if (!armed) {
    hold.watch = null
    return
  }
  if (downloads === undefined) return
  watch.on('Browser.downloadWillBegin', event => downloadBegan(state, hold, event))
  watch.on('Browser.downloadProgress', event => downloadMoved(state, hold, event))
  const followed = await watch
    .send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: path.join(downloads.home, 'incoming'), eventsEnabled: true })
    .then(() => true, passedOverAs(false))
  if (followed) hold.downloads = downloads
}
