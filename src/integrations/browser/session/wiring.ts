import { chromeNetErrorFor } from '../metadataProxy.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { CDPSession, HTTPRequest, Page, Protocol } from 'puppeteer-core'
import puppeteerPkg from 'puppeteer-core/package.json' with { type: 'json' }
import { beginTransfer, moveTransfer } from '../browserTransfers.js'
import { sleep } from '../../../platform/async/sleep.js'
import { type ConsoleEntry, CONSOLE_RING_CAP, CONSOLE_ENTRY_CAP, POPUP_NOTES_KEPT, type DownloadNotice, isBrowserErrorPage, type Wiring, type Hold, type AttachedBrowser, type Session, type OwnerBrowserState, type PagePresented } from './shapes.js'
import { closeChild, closeHoldNetwork, sweepDownloads, sessionHolds, sessionWirings, holdOf, originOf, tabClosed } from './owners.js'
import { pageKits } from './stealth.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'

export const redactUrl = (url: string): string => {
  const q = url.indexOf('?')
  return q === -1 ? url : `${url.slice(0, q)}?…`
}

export function newWiring(): Wiring {
  const consoleRing: ConsoleEntry[] = []
  const capture = (kind: string, text: string): void => {
    const bounded =
      text.length > CONSOLE_ENTRY_CAP
        ? `${text.slice(0, CONSOLE_ENTRY_CAP)}… [+${text.length - CONSOLE_ENTRY_CAP} chars]`
        : text
    consoleRing.push({ at: Date.now(), kind, text: bounded })
    if (consoleRing.length > CONSOLE_RING_CAP) consoleRing.shift()
  }
  return {
    consoleRing,
    nav: { seq: 0, seen: 0, web: 0 },
    popups: { count: 0, last: '', log: [], waiters: [] },
    navFailure: { last: null },
    policyBlocks: new Map(),
    downloads: { count: 0, last: null, waiters: [], late: [] },
    navWatch: { pendingUrl: null, frames: 0, abortedAt: 0, waiters: [] },
    docResponses: new Map(),
    capture,
  }
}

export function listenProtocol(wiring: Wiring, cdp: CDPSession): void {
  const { policyBlocks, docResponses, capture } = wiring
  const requests = new Map<string, string>()
  cdp.on('Network.responseReceived', event => {
    if (event.type !== 'Document') return
    const declared = Object.entries(event.response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
    docResponses.set(redactUrl(event.response.url), declared ?? null)
    if (docResponses.size > 32) docResponses.delete(docResponses.keys().next().value!)
  })
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
}

function downloadNotice(wiring: Wiring, event: Protocol.Browser.DownloadWillBeginEvent): DownloadNotice & { finish: () => void } {
  const { downloads, docResponses } = wiring
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
    transfer: null,
    finish,
  }
  downloads.count++
  downloads.last = notice
  for (const wake of downloads.waiters.splice(0)) wake()
  return notice
}

export function listenDownloads(wiring: Wiring, cdp: CDPSession): void {
  const { downloads, docResponses, capture } = wiring
  cdp.on('Browser.downloadWillBegin', event => {
    const notice = downloadNotice(wiring, event)
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

const DOWNLOAD_NOT_SAVED =
  'not saved: no act of this agent started it; op:"download" with url (the page’s address) or selector (what starts it) saves it'

export function downloadBegan(state: OwnerBrowserState, hold: Hold, event: Protocol.Browser.DownloadWillBeginEvent): void {
  const framed = (session: Session): boolean => session.page.frames().some(frame => (frame as { _id?: string })._id === event.frameId)
  const tab = [...hold.tabs].find(framed) ?? null
  const birth = tab === null ? (hold.births.get(event.frameId) ?? hold.died.get(event.frameId) ?? null) : null
  const actor = tab ?? birth?.opener ?? null
  const wiring = actor === null ? undefined : sessionWirings.get(actor)
  const inAct = tab !== null ? tab.acting > 0 : birth !== null && birth.keep
  if (actor === null || wiring === undefined || hold.downloads === null || !(inAct || tab?.touched === true)) {
    hold.unwanted.add(event.guid)
    void hold.watch?.send('Browser.cancelDownload', { guid: event.guid }).catch(passedOverAs(undefined))
    const words = `the page asked to download ${event.suggestedFilename} (${redactUrl(event.url)}) — ${DOWNLOAD_NOT_SAVED}`
    wiring?.capture('download', words)
    wiring?.downloads.late.push(words)
    return
  }
  hold.downloads.claim()
  const notice = downloadNotice(wiring, event)
  notice.transfer = beginTransfer(state.transfers, { guid: event.guid, tab: actor.tab, url: notice.url, name: notice.filename, type: notice.type, home: hold.downloads.home })
  hold.arriving.set(event.guid, { notice, wiring })
  wiring.capture('download', `download ${notice.transfer.id}: ${notice.filename} (${notice.url}) is being saved in the session scratchpad`)
  wiring.downloads.late.push(notice.transfer)
}

export function downloadMoved(state: OwnerBrowserState, hold: Hold, event: Protocol.Browser.DownloadProgressEvent): void {
  if (hold.unwanted.has(event.guid) && event.state !== 'inProgress' && hold.downloads !== null) {
    hold.unwanted.delete(event.guid)
    fs.rm(path.join(hold.downloads.home, 'incoming', event.guid), { force: true }, () => undefined)
    return
  }
  const arriving = hold.arriving.get(event.guid)
  if (arriving === undefined) return
  const { notice, wiring } = arriving
  if (event.totalBytes > 0) notice.bytes = event.totalBytes
  if (notice.type === null) notice.type = wiring.docResponses.get(notice.url) ?? null
  if (notice.transfer !== null && notice.transfer.type === null) notice.transfer.type = notice.type
  moveTransfer(state.transfers, event.guid, event)
  if (event.state === 'inProgress') return
  hold.arriving.delete(event.guid)
  notice.finish()
  if (hold.tabs.size === 0 && hold.creating === 0 && hold.arriving.size === 0 && !state.launching && state.holds.delete(hold)) {
    closeHoldNetwork(hold)
    void closeChild(hold.browser).then(() => sweepDownloads(state, hold))
  }
}

export function targetIdOf(page: Page): string | null {
  const target = typeof page.target === 'function' ? (page.target() as { _targetId?: unknown } | null) : null
  return typeof target?._targetId === 'string' ? target._targetId : null
}

export function forgetClicked(session: Session): void {
  const held = session.clicked
  session.clicked = null
  void held?.target.dispose().catch(passedOver)
}

export function tabSession(state: OwnerBrowserState, hold: Hold, tab: string, page: Page, wiring: Wiring): Session {
  const session: Session = {
    tab,
    serial: ++state.pages,
    persist: false,
    openedBy: null,
    crashed: false,
    acting: 0,
    actOp: '',
    touched: false,
    left: false,
    opening: null,
    browser: hold.browser,
    page,
    resolution: hold.resolution,
    driverVersion: (puppeteerPkg as { version?: string }).version ?? 'bundled',
    consoleRing: wiring.consoleRing,
    nav: wiring.nav,
    sandboxDowngraded: hold.sandboxDowngraded,
    popups: wiring.popups,
    navFailure: wiring.navFailure,
    networkRefusal: hold.networkRefusal,
    policyBlocks: wiring.policyBlocks,
    closeNetwork: hold.closeNetwork,
    downloads: wiring.downloads,
    navWatch: wiring.navWatch,
    profileOrigin: hold.profileOrigin,
    profileDir: hold.profileDir,
    headless: hold.headless,
    cursor: { x: 160, y: 120 },
    clicked: null,
  }
  sessionHolds.set(session, hold)
  sessionWirings.set(session, wiring)
  const id = targetIdOf(page)
  if (id !== null) hold.owned.set(id, session)
  return session
}

export async function armAttachedPage(page: Page, wiring: Wiring, baseline: PagePresented): Promise<void> {
  const cdp = typeof page.createCDPSession === 'function' ? await page.createCDPSession().catch(passedOverAs(null)) : null
  pageKits.set(page, { cdp, identity: null, languages: baseline.languages, timeZone: baseline.timeZone, presented: null, born: null, fetchHeld: false })
  if (cdp === null) return
  await cdp.send('Network.enable').catch(passedOverAs(undefined))
  listenProtocol(wiring, cdp)
}

export function adoptAttachedPage(state: OwnerBrowserState, hold: Hold, attached: AttachedBrowser, page: Page): { session: Session; armed: Promise<void> } {
  const known = [...hold.tabs].find(session => session.page === page)
  if (known !== undefined) return { session: known, armed: Promise.resolve() }
  const wiring = newWiring()
  let name = `tab-${++attached.adopted}`
  while (state.tabs.has(name)) name = `tab-${++attached.adopted}`
  const session = tabSession(state, hold, name, page, wiring)
  listenPage(state, session, wiring)
  hold.tabs.add(session)
  state.tabs.set(name, session)
  state.ended.delete(name)
  return { session, armed: armAttachedPage(page, wiring, hold.baseline) }
}

function popupTabName(state: OwnerBrowserState): string {
  for (;;) {
    state.popups++
    const name = state.popups === 1 ? 'popup' : `popup-${state.popups}`
    if (!state.tabs.has(name)) return name
  }
}

export function listenPage(state: OwnerBrowserState, session: Session, wiring: Wiring): void {
  const { page } = session
  const hold = holdOf(session)
  const { nav, popups, navFailure, navWatch, docResponses, capture } = wiring
  let shown = hold.attached === null ? '' : originOf(page.url())
  const settleNav = (): void => {
    navWatch.pendingUrl = null
    for (const wake of navWatch.waiters.splice(0)) wake()
  }
  const settleFrame = (): void => {
    navWatch.frames = Math.max(0, navWatch.frames - 1)
    if (navWatch.frames === 0) for (const wake of navWatch.waiters.splice(0)) wake()
  }
  const isMainNavigation = (request: HTTPRequest): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame()
  const driver = page as Page & { _client?: () => CDPSession }
  if (typeof driver._client === 'function') {
    driver._client().on('Page.windowOpen', event => {
      session.opening = event.url
    })
  }
  page.on('framenavigated', frame => {
    if (frame.parentFrame() === null) {
      forgetClicked(session)
      navWatch.frames = 0
      nav.seq++
      if (/^https?:/i.test(frame.url())) nav.web++
      if (!isBrowserErrorPage(frame.url())) navFailure.last = null
      settleNav()
      const landed = originOf(frame.url())
      if (hold.attached !== null && landed !== shown) wiring.consoleRing.splice(0)
      shown = landed
      capture('nav', `navigated to ${redactUrl(frame.url())}`)
    }
  })
  page.on('request', request => {
    if (isMainNavigation(request)) navWatch.pendingUrl = redactUrl(request.url())
    else if (request.isNavigationRequest()) navWatch.frames++
  })
  page.on('requestfinished', request => {
    if (isMainNavigation(request)) settleNav()
    else if (request.isNavigationRequest()) settleFrame()
  })
  page.on('console', message => {
    const loc = message.location()
    const where = loc.url ? ` @ ${redactUrl(loc.url)}:${loc.lineNumber ?? 0}` : ''
    const args = message.args()
    const from = shown
    const said = (text: string): void => {
      if (hold.attached === null || from === shown) capture(message.type(), text)
    }
    if (args.length === 0) {
      said(`${message.text()}${where}`)
      return
    }
    void Promise.all(args.map(a => a.jsonValue().catch(passedOverAs(undefined))))
      .then(vals => {
        const rendered = vals
          .map(v => (v === undefined ? '<unserializable>' : typeof v === 'string' ? v : JSON.stringify(v)))
          .join(' ')
        said(`${rendered.trim() !== '' ? rendered : message.text()}${where}`)
      })
      .catch(() => said(`${message.text()}${where}`))
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
      const id = targetIdOf(popup)
      const born = id === null ? undefined : hold.births.get(id)
      let url = popup.url()
      if (!url || url === 'about:blank') {
        await sleep(300)
        url = popup.url()
      }
      if (hold.attached !== null) {
        const kept = session.left || state.disposed || popup.isClosed() ? null : adoptAttachedPage(state, hold, hold.attached, popup).session
        popups.count++
        popups.last = redactUrl(url || '(unknown)')
        popups.log.push({ url: popups.last, tab: kept?.tab ?? null })
        if (popups.log.length > POPUP_NOTES_KEPT) popups.log.shift()
        capture('popup', kept === null ? `the page opened a new tab: ${popups.last} — it has closed since` : `the page opened a new tab: ${popups.last} — it stays open in its browser: tab ${kept.tab}`)
        return
      }
      const download = born !== undefined && hold.downloads === null && (!url || url === 'about:blank') ? born.wiring.downloads.last : null
      let name: string | null = null
      if (born !== undefined && born.keep && download === null && !session.left && !state.disposed && !popup.isClosed()) {
        name = popupTabName(state)
        pageKits.set(popup, born.kit)
        const kept = tabSession(state, hold, name, popup, born.wiring)
        kept.openedBy = { tab: session.tab, op: session.actOp, posted: born.posted }
        kept.touched = true
        born.handover()
        listenPage(state, kept, born.wiring)
        hold.tabs.add(kept)
        hold.front = kept
        state.tabs.set(name, kept)
        state.ended.delete(name)
        born.wiring.capture('popup', `opened by ${session.actOp} on tab ${session.tab}`)
      }
      if (download !== null) {
        downloadInNewTab(wiring, download)
      } else {
        popups.count++
        popups.last = redactUrl(url || '(unknown)')
        popups.log.push({ url: popups.last, tab: name })
        if (popups.log.length > POPUP_NOTES_KEPT) popups.log.shift()
        capture(
          'popup',
          name === null
            ? `the page opened a new tab: ${popups.last} — closed unadopted (no act opened it; op:"open" follows it)`
            : `the page opened a new tab: ${popups.last} — kept as tab ${name}`,
        )
      }
      if (name === null) await popup.close().catch(passedOver)
      if (born !== undefined && id !== null) {
        hold.births.delete(id)
        born.handover()
        born.settle()
      }
    })()
  })
  page.on('requestfailed', request => {
    const chromeText = request.failure()?.errorText ?? ''
    const relay = chromeText === 'net::ERR_ABORTED' ? null : hold.relayFailureFor(request.url())
    const errorText = relay === null ? chromeText : `net::${chromeNetErrorFor(relay.code)}`
    if (isMainNavigation(request)) {
      if (errorText === 'net::ERR_ABORTED') navWatch.abortedAt = Date.now()
      else navFailure.last = { url: redactUrl(request.url()), errorText, at: Date.now() }
      settleNav()
    } else if (request.isNavigationRequest()) {
      if (errorText === 'net::ERR_ABORTED') navWatch.abortedAt = Date.now()
      settleFrame()
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
    void (kind === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(passedOver)
  })
  page.on('close', () => tabClosed(state, session))
  page.on('error', () => {
    session.crashed = true
    capture('crash', 'the page crashed (its process exited); op:"reload" loads it again')
  })
}

export function downloadInNewTab(wiring: Wiring, download: DownloadNotice): void {
  wiring.downloads.count++
  wiring.downloads.last = download
  for (const wake of wiring.downloads.waiters.splice(0)) wake()
  wiring.capture('download', `the page asked to download ${download.filename} (${download.url}) in a new tab — denied: downloads are not followed here`)
}
