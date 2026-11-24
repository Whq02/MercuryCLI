import { POPUP_SETTLE_MS, FIRST_NAVIGATION_SILENCE_MS, FIRST_NAVIGATION_STARTS, type Session } from './shapes.js'
import { holdOf } from './owners.js'
import { pageKits } from './stealth.js'
import { abortReason } from './launch.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'
import { withDeadline } from '../../../platform/async/deadline.js'

function leftForHost(origins: Set<string>, url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname
  } catch (error) {
    passedOver(error)
    return true
  }
  for (const origin of origins) {
    try {
      if (new URL(origin).hostname === host) return true
    } catch (error) {
      passedOver(error)
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
    void pageKits.get(session.page)?.cdp?.send('Page.stopLoading').catch(passedOverAs(undefined))
    return abortReason(signal as AbortSignal)
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
      const ended = (until: number | null): Promise<{ value: T } | { error: unknown } | null> =>
        withDeadline(
          settled,
          until === null ? Number.POSITIVE_INFINITY : Math.max(0, until - Date.now()),
          () => null,
          { signal, onAbort: () => null },
        )
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
          await withDeadline(
            new Promise<never>(() => {}),
            Math.max(0, startedAt + FIRST_NAVIGATION_SILENCE_MS - Date.now()),
            () => undefined,
            { signal, onAbort: () => undefined },
          )
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
    await withDeadline(Promise.all(pending.map(birth => birth.settled)), left, () => undefined)
  }
}

export async function bringTabToFront(session: Session): Promise<void> {
  const hold = holdOf(session)
  if (hold.front === session) return
  const painting = hold.attached !== null && (await session.page.emulateFocusedPage(true).then(() => true, passedOverAs(false)))
  if (!painting && typeof session.page.bringToFront === 'function') await session.page.bringToFront().catch(passedOverAs(undefined))
  hold.front = session
}
