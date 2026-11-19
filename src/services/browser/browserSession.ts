
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getMercuryHome } from '../../utils/envUtils.js'
import { POPUP_SETTLE_MS, FIRST_NAVIGATION_SILENCE_MS, FIRST_NAVIGATION_STARTS, type Session } from './session/shapes.js'
import { holdOf } from './session/owners.js'
import { pageKits } from './session/stealth.js'
import { abortReason } from './session/launch.js'
export type { ConsoleEntry, NavFailure, DownloadNotice, PopupNote, CheckedTarget, EnsureSessionRefusal, EnsureBrowserSessionOptions, PageIdentity, PagePresented, PageKit } from './session/shapes.js'
export { CONSOLE_RING_CAP, CONSOLE_ENTRY_CAP, MAIN_TAB, isBrowserErrorPage, BROWSER_CLOSE_BOUND_MS, BROWSER_FINISH_BOUND_MS, BROWSER_PROTOCOL_TIMEOUT_MS, NAVIGATION_CAP_MS } from './session/shapes.js'
export type { CloseOutcome } from './session/owners.js'
export { beginBrowserActivity, tempProfileDirOf, removeTempProfile, childGone, setBrowserLaunchDriverForProof, disposeBrowserOwner, browserSessionCap, liveBrowserSessionCensus, originOf, noteCheckedActOrigin, consumeCheckedActOrigin, noteEmulatedPage, emulatedPageOf, originApproved, approveWebOrigin, approvedOriginList, activeSession, browserTransfers, browserTabs, endedTab, sessionGoneAt, driverVersion, secretPairingKey, secretPairingApproved, approveSecretPairing } from './session/owners.js'
export { resolveHostLanguages, resolveNavigatorPlatform, pageKitOf } from './session/stealth.js'
export { presentToFrames, sessionOfFrame } from './session/births.js'
export { browserProfileDirForOrigin, ensureBrowserSession, closeBrowserSession, closeBrowserSessionDetailed } from './session/launch.js'

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

export function screenshotPath(label: string): string {
  const dir = path.join(getMercuryHome(), 'browser-shots')
  fs.mkdirSync(dir, { recursive: true })
  const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'shot'
  return path.join(dir, `${Date.now()}-${safe}.png`)
}
