import {
  activeSession,
  isBrowserErrorPage,
  noteEmulatedPage,
  originApproved,
  originOf,
  pageKitOf,
  popupInFlight,
  popupsSettled,
} from '../../../services/browser/browserSession.js'
import { emulationActive, emulationSummary, inheritEmulation } from '../../../services/browser/browserEmulation.js'
import type { OwnerKey } from '../../../services/run/ownerKey.js'
import { type LiveSession, bounded, pageWhere } from './page.js'
import { downloadWords } from './downloads.js'

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
    await Promise.race([
      s.page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))).catch(() => undefined),
      bounded(1000),
      new Promise<void>(wake => s.popups.waiters.push(wake)),
    ])
  }
  await popupsSettled(s)
  const until = Date.now() + deadline
  while ((s.navWatch.pendingUrl !== null || s.navWatch.frames > 0) && Date.now() < until) {
    await Promise.race([new Promise<void>(wake => s.navWatch.waiters.push(wake)), bounded(until - Date.now())])
  }
  if (s.navWatch.abortedAt >= marks.at && s.downloads.count === marks.downloads) {
    await Promise.race([new Promise<void>(wake => s.downloads.waiters.push(wake)), bounded(1000)])
  }
  const download = s.downloads.last
  if (download !== null && s.downloads.count > marks.downloads) await Promise.race([download.transfer?.done ?? download.done, bounded(1000)])
}

export async function errorPageSettled(s: LiveSession): Promise<void> {
  if (s.navFailure.last === null || isBrowserErrorPage(s.page.url())) return
  await Promise.race([new Promise<void>(wake => s.navWatch.waiters.push(wake)), bounded(1000)])
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
    const carried = await inheritEmulation(s.page, kept.page, kept.openedBy?.posted !== true).catch(() => null)
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
