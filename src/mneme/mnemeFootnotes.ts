import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import { expandSeqRange, type MnemeEntry, type MnemeTopicDoc } from './mnemeTopicDocs.js'
import { bumpUsage, readPins } from './mnemeUsage.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { readLedger } from './ledger.js'
import { mnemeProjectKey } from './paths.js'
import type { LedgerEntry } from './types.js'

export function confirmCitedFacts(text: string, dir: string = mnemeLibraryDir(), now: Date = new Date()): number[] {
  if (!mnemeEnabled()) return []
  const cited = new Set([...text.matchAll(/\[seq[ :]+(\d+)\]/g)].map(m => Number(m[1])))
  if (cited.size === 0) return []
  const live = [...listTopicDocs(dir), ...listArchiveDocs(dir)].flatMap(doc => doc.sections.flatMap(section => section.entries.map(entry => entry.seq)))
  const confirmed = [...new Set(live.filter(seq => cited.has(seq)))]
  bumpUsage(confirmed, dir, now, false)
  return confirmed
}

export interface Footnotes {
  session?: number
  ruling?: string
  supersededBy?: string
  supersedes?: string
}

export interface RulingRecord {
  seq: number
  time: string
  session: string | null
  ordinal?: number
}

export interface FootnoteContext {
  sessions: readonly LedgerEntry[]
  rulings: readonly RulingRecord[]
}

export function currentLedger(): LedgerEntry[] {
  try {
    return readLedger(mnemeProjectKey())
  } catch {
    return []
  }
}

export function sessionOfSource(source: string): string | null {
  const m = /(?:^|\s)s:([A-Za-z0-9_-]+)/.exec(source)
  return m ? m[1]! : null
}

export function sessionOrdinal(session: string | null, sessions: readonly LedgerEntry[]): number | undefined {
  if (!session) return undefined
  const hit = sessions.find(s => s.sessionId === session || s.sessionId.startsWith(session))
  return hit?.ordinal
}

export function entryIndex(docs: Iterable<MnemeTopicDoc>): Map<number, MnemeEntry> {
  const out = new Map<number, MnemeEntry>()
  for (const d of docs) {
    for (const s of d.sections) for (const e of s.entries) out.set(e.seq, e)
    for (const e of d.history) out.set(e.seq, e)
  }
  return out
}

function resolveRulingId(id: string, entries: Map<number, MnemeEntry>): MnemeEntry | undefined {
  const seq = /^seq:(\d+)$/.exec(id)
  if (seq) return entries.get(Number(seq[1]))
  const pending = /^pending:(.+)$/.exec(id)
  if (pending) {
    for (const e of entries.values()) if (e.time === pending[1]) return e
  }
  return undefined
}

export function rulingRecords(dir: string, sessions: readonly LedgerEntry[]): RulingRecord[] {
  const entries = entryIndex([...listTopicDocs(dir), ...listArchiveDocs(dir)])
  const out = new Map<number, RulingRecord>()
  const add = (e: MnemeEntry, ordinal?: number): void => {
    const session = sessionOfSource(e.source)
    const prior = out.get(e.seq)
    if (prior) {
      if (prior.ordinal === undefined && ordinal !== undefined) prior.ordinal = ordinal
      return
    }
    out.set(e.seq, { seq: e.seq, time: e.time, session, ordinal: ordinal ?? sessionOrdinal(session, sessions) })
  }
  const queue = readPins(dir).map(p => p.seq)
  const walked = new Set<number>()
  while (queue.length > 0) {
    const seq = queue.pop()!
    if (walked.has(seq)) continue
    walked.add(seq)
    const e = entries.get(seq)
    if (!e) continue
    add(e)
    for (const t of e.supersedes ? expandSeqRange(e.supersedes) : []) queue.push(t)
  }
  for (const s of sessions) {
    for (const id of s.rulings) {
      const e = resolveRulingId(id, entries)
      if (e) add(e, s.ordinal)
    }
  }
  return [...out.values()].sort((a, b) => a.seq - b.seq)
}

export function footnoteContext(dir: string, sessions: readonly LedgerEntry[] = []): FootnoteContext {
  return { sessions, rulings: rulingRecords(dir, sessions) }
}

function rulingFor(entry: Pick<MnemeEntry, 'seq' | 'time'>, session: string | null, ordinal: number | undefined, ctx: FootnoteContext): number | undefined {
  let best: RulingRecord | undefined
  for (const r of ctx.rulings) {
    if (r.seq === entry.seq) continue
    const sameSession = (session !== null && r.session === session) || (ordinal !== undefined && r.ordinal === ordinal)
    if (!sameSession || r.time > entry.time) continue
    if (!best || r.time > best.time || (r.time === best.time && r.seq > best.seq)) best = r
  }
  return best?.seq
}

export function footnotesOf(
  entry: Pick<MnemeEntry, 'seq' | 'time' | 'source' | 'supersedes' | 'supersededBy'>,
  ctx: FootnoteContext,
): Footnotes {
  const out: Footnotes = {}
  const session = sessionOfSource(entry.source)
  const ordinal = sessionOrdinal(session, ctx.sessions)
  if (ordinal !== undefined) out.session = ordinal
  const ruling = rulingFor(entry, session, ordinal, ctx)
  if (ruling !== undefined) out.ruling = `seq:${ruling}`
  if (entry.supersedes) out.supersedes = expandSeqRange(entry.supersedes).map(s => `seq:${s}`).join(', ')
  if (entry.supersededBy !== undefined) out.supersededBy = `seq:${entry.supersededBy}`
  return out
}

export function renderFootnotes(f: Footnotes): string {
  const parts: string[] = []
  if (f.session !== undefined) parts.push(`session ${f.session} (ledger:${f.session})`)
  if (f.ruling) parts.push(`ruling ${f.ruling}`)
  if (f.supersedes) parts.push(`supersedes ${f.supersedes}`)
  if (f.supersededBy) parts.push(`superseded by ${f.supersededBy}`)
  return parts.join(' · ')
}

export const NO_NOTE_LEFT = 'no note left'

function idList(label: string, ids: readonly string[]): string {
  return ids.length === 0 ? `${label}: none` : `${label} (${ids.length}): ${ids.join(', ')}`
}

export function renderLedgerEntry(s: LedgerEntry, count: number): string {
  const lines: string[] = [`session ${s.ordinal} of ${count} · ${s.sessionId}`]
  lines.push(s.endedAt === null ? `started ${s.startedAt} · still open` : `started ${s.startedAt} · ended ${s.endedAt}${s.outcome ? ` (${s.outcome})` : ''}`)
  if (s.endedAt !== null) {
    lines.push(s.engines.length === 0 ? 'engines: none recorded' : `engines: ${s.engines.map(e => `${e.model} from ${e.at}`).join('; ')}`)
  }
  lines.push(idList('rulings', s.rulings), idList('retained', s.retained), idList('corrected', s.corrected), idList('files', s.files))
  if (s.handoff === null) lines.push(`handoff: ${NO_NOTE_LEFT}`)
  else lines.push(`handoff (${s.handoff.at}):`, s.handoff.text)
  return lines.join('\n')
}
