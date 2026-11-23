import {
  activeSession,
  isBrowserErrorPage,
  noteEmulatedPage,
  originApproved,
  originOf,
  pageKitOf,
  popupInFlight,
  popupsSettled,
} from '../../../integrations/browser/browserSession.js'
import { emulationActive, emulationSummary, inheritEmulation } from '../../../integrations/browser/browserEmulation.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { type LiveSession, pageWhere } from './page.js'
import { downloadWords } from './downloads.js'
import { withDeadline } from '../../../platform/async/deadline.js'
import { passedOverAs } from '../../../platform/errors/passedOver.js'

interface ActMarks {
  at: number
  ringMark: number
  popups: number
  downloads: number
  url: string
}

export function markAct(s: LiveSession): ActMarks {
  s.navWatch.frames = 0
  return { at: Date.now(), ringMark: s.consoleRing.length, popups: s.popups.count, downloads: s.downloads.count, url: s.page.url() }
}

export async function settleAfterAct(s: LiveSession, deadline: number, marks: ActMarks): Promise<void> {
  if (s.popups.count === marks.popups && !popupInFlight(s)) {
    await withDeadline(
      new Promise<void>(wake => {
        s.popups.waiters.push(wake)
        void s.page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))).then(() => wake(), () => wake())
      }),
      1000,
      () => {},
      { unref: true },
    )
  }
  await popupsSettled(s)
  const until = Date.now() + deadline
  while ((s.navWatch.pendingUrl !== null || s.navWatch.frames > 0) && Date.now() < until) {
    await withDeadline(new Promise<void>(wake => s.navWatch.waiters.push(wake)), Math.max(0, until - Date.now()), () => {}, { unref: true })
  }
  if (s.navWatch.abortedAt >= marks.at && s.downloads.count === marks.downloads) {
    await withDeadline(new Promise<void>(wake => s.downloads.waiters.push(wake)), 1000, () => {}, { unref: true })
  }
  const download = s.downloads.last
  if (download !== null && s.downloads.count > marks.downloads) await withDeadline(download.transfer?.done ?? download.done, 1000, () => {}, { unref: true })
}

export async function errorPageSettled(s: LiveSession): Promise<void> {
  if (s.navFailure.last === null || isBrowserErrorPage(s.page.url())) return
  await withDeadline(new Promise<void>(wake => s.navWatch.waiters.push(wake)), 1000, () => {}, { unref: true })
}

export function firstRequestWords(s: LiveSession): string {
  return `tab ${s.tab}: its first request was not armed with the presented browser identity; the page stayed open`
}
export async function popupWords(owner: OwnerKey, s: LiveSession, since: number): Promise<string> {
  await popupsSettled(s)
  const fresh = s.popups.count - since
  if (fresh <= 0) return ''
  const notes: string[] = []
  for (const popup of s.popups.log.slice(-fresh)) {
    const kept = popup.tab === null ? null : activeSession(owner, popup.tab)
    if (kept === null) {
      notes.push(
        popup.tab === null
          ? `the page opened a new tab (${popup.url}) that could not be kept; it was closed. op:"open" that URL follows it (a new origin will ask).`
          : `the page opened a new tab (${popup.url}), kept as tab ${popup.tab}, which has closed since`,
      )
      continue
    }
    const origin = originOf(kept.page.url())
    const carried = await inheritEmulation(s.page, kept.page, kept.openedBy?.posted !== true).catch(passedOverAs(null))
    if (carried !== null) noteEmulatedPage(owner, emulationActive(kept.page) ? kept.page : null, kept.tab)
    notes.push(
      `the page opened a new tab — kept as tab ${kept.tab} at ${pageWhere(kept)}${origin.startsWith('http') && !originApproved(owner, origin) ? ' (its origin is not approved: acts there will ask)' : ''}; pass tab:"${kept.tab}" to use it${
        carried === null ? '' : `; the emulation came with it (${emulationSummary(kept.page) || 'nothing'})${carried.reloaded ? ', and it was reloaded for mobile or touch' : ''}`
      }`,
    )
    if (pageKitOf(kept.page)?.firstRequestUnarmed) notes.push(firstRequestWords(kept))
    for (const line of [...(carried?.failures ?? []), ...(carried?.notes ?? [])]) notes.push(`tab ${kept.tab}: ${line}`)
  }
  return notes.map(n => `\n  note: ${n}`).join('')
}

export function actConsequences(s: LiveSession, marks: ActMarks): string {
  const notes: string[] = []
  if (s.downloads.count > marks.downloads && s.downloads.last !== null) {
    notes.push(`the link is ${downloadWords(s.downloads.last)}`)
  }
  for (const entry of s.consoleRing.slice(marks.ringMark)) {
    if (entry.kind === 'dialog') notes.push(`the page opened a dialog: ${entry.text}`)
  }
  return notes.map(n => `\n  note: ${n}`).join('')
}
