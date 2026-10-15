import { dirname } from 'node:path'
import { ledgerEntryOf, liveSessions, readLedger } from './ledger.js'
import { lineageKept } from './lineageSession.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { readPinnedStatus } from './mnemeFrontPage.js'
import { readPins } from './mnemeUsage.js'
import { lineagePath } from './paths.js'
import type { LedgerEntry } from './types.js'
import { gradeLines, HANDOFF_GRADE } from './memoryEvidence.js'

export const ENTRY_PAGE_HEADING = '# Lineage'
export const FIRST_SESSION_LINE = 'First session of this work; no record.'
export const NO_RECORD_KEPT_LINE = 'No record of this work is kept: records.retentionDays is 0.'
export const NO_NOTE_LEFT = 'left no note'

const pad = (n: number): string => String(n).padStart(2, '0')

export function stampLocal(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)})`
}

export interface EntryPageOptions {
  journal?: () => { at: string; text: string } | null
}

function enginesLine(previous: readonly LedgerEntry[]): string | null {
  const firstSeen = new Map<string, { at: string; ordinal: number }>()
  for (const entry of previous) {
    for (const engine of entry.engines) {
      if (!firstSeen.has(engine.model)) firstSeen.set(engine.model, { at: engine.at, ordinal: entry.ordinal })
    }
  }
  if (firstSeen.size === 0) return null
  const parts = [...firstSeen.entries()].map(([model, seen]) => `${model} from ${stampLocal(seen.at)} (session ${seen.ordinal})`)
  return `Engines before this session: ${parts.join('; ')}.`
}

const JOURNAL_CLOSE_SLACK_MS = 5_000

export function sessionOfJournalEntry(entries: readonly LedgerEntry[], at: string): LedgerEntry | null {
  const when = Date.parse(at)
  if (Number.isNaN(when)) return null
  let found: LedgerEntry | null = null
  for (const entry of entries) {
    const started = Date.parse(entry.startedAt)
    const ended = entry.endedAt === null ? Number.NaN : Date.parse(entry.endedAt)
    if (Number.isNaN(started) || Number.isNaN(ended)) continue
    if (when >= started && when <= ended + JOURNAL_CLOSE_SLACK_MS) found = entry
  }
  return found
}

function rulingsLine(): string {
  const dir = mnemeLibraryDir()
  const count = readPinnedStatus(dir)?.pinned ?? readPins(dir).length
  if (count === 0) return 'Standing rulings: none pinned.'
  return `Standing rulings: ${count} pinned rule${count === 1 ? '' : 's'} — the Pinned section of the memory page above carries ${count === 1 ? 'it' : 'them'} word for word.`
}

export function composeEntryPage(projectKey: string, sessionId?: string, options: EntryPageOptions = {}): string | null {
  if (!mnemeEnabled()) return null
  if (!lineageKept()) return `${ENTRY_PAGE_HEADING}\n${NO_RECORD_KEPT_LINE}`
  const entries = readLedger(projectKey)
  const { listArchiveDocs, listTopicDocs } = require('./mnemeLibrary.js') as typeof import('./mnemeLibrary.js')
  const { pendingRows } = require('./mnemeBuffer.js') as typeof import('./mnemeBuffer.js')
  const dir = mnemeLibraryDir()
  if (!entries.some(entry => entry.handoff?.text.trim()) && readPins(dir).length === 0 && pendingRows(dir).length === 0 && [...listTopicDocs(dir), ...listArchiveDocs(dir)].every(doc => doc.sections.every(section => section.entries.length === 0))) return null
  const own = sessionId !== undefined ? (ledgerEntryOf(projectKey, sessionId) ?? null) : null
  const previous = entries.filter(entry => entry.sessionId !== sessionId)
  if (previous.length === 0) return `${ENTRY_PAGE_HEADING}\n${FIRST_SESSION_LINE}`
  const ordinal = own?.ordinal ?? entries.length + 1
  const unclosed = previous.filter(entry => entry.endedAt === null).length
  const lines: string[] = [ENTRY_PAGE_HEADING]
  lines.push(
    `Session ${ordinal} of this work; ${previous.length} session${previous.length === 1 ? '' : 's'} before it${unclosed > 0 ? ` (${unclosed} of them ended without closing ${unclosed === 1 ? 'its' : 'their'} entry)` : ''}. The ledger is under ${dirname(lineagePath(projectKey))}.`,
  )
  const engines = enginesLine(previous)
  if (engines !== null) lines.push(engines)
  lines.push(rulingsLine())
  const live = liveSessions(projectKey).filter(session => session.sessionId !== sessionId)
  for (const session of live) {
    lines.push(`Another session of this work has been live here since ${session.startedAt === '' ? 'an unknown time' : stampLocal(session.startedAt)}.`)
  }
  const last = previous[previous.length - 1]!
  const lastNoted = [...previous].reverse().find(entry => entry.handoff !== null) ?? null
  const journal = options.journal?.() ?? null
  const journalSession = journal !== null ? sessionOfJournalEntry(previous, journal.at) : null
  if (last.handoff === null) {
    const below = journalSession !== null && journalSession.ordinal === last.ordinal ? '; its journal entry is below' : ''
    lines.push(`The last session (${last.ordinal}, ${last.endedAt === null ? 'never closed' : `ended ${stampLocal(last.endedAt)}`}) ${NO_NOTE_LEFT}${below}.`)
  }
  if (lastNoted !== null && lastNoted.handoff !== null) {
    lines.push('', `## The last note left (session ${lastNoted.ordinal}, ${stampLocal(lastNoted.handoff.at)})`, gradeLines(lastNoted.handoff.text, HANDOFF_GRADE))
  }
  if (journal !== null) {
    lines.push('', `## The journal's last entry (${stampLocal(journal.at)}${journalSession !== null ? `, session ${journalSession.ordinal}'s own account — not a note left for you` : " — the model's own account, not a note left for you"})`, gradeLines(journal.text, HANDOFF_GRADE))
  }
  return lines.join('\n')
}
