import { getSessionId } from '../bootstrap/state.js'
import { pendingRows } from './mnemeBuffer.js'
import { currentLedger, footnoteContext, footnotesOf, sessionOrdinal, type FootnoteContext, type RulingRecord } from './mnemeFootnotes.js'
import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import type { LookupCandidate } from './mnemeLookup.js'
import { expandSeqRange, type MnemeEntry, type MnemeTopicDoc } from './mnemeTopicDocs.js'
import { readUsage, type UsageRecord } from './mnemeUsage.js'
import type { LedgerEntry } from './types.js'

export const RULING_LIFT_PLACES = 2

export function liftLinked(order: readonly string[], linked: ReadonlySet<string>, places: number = RULING_LIFT_PLACES): string[] {
  const out = [...order]
  for (let i = 1; i < out.length; i++) {
    const id = out[i]!
    if (!linked.has(id)) continue
    for (let j = i, moved = 0; moved < places && j > 0 && !linked.has(out[j - 1]!); j--, moved++) {
      out[j] = out[j - 1]!
      out[j - 1] = id
    }
  }
  return out
}

export function flowedUsage(docs: readonly MnemeTopicDoc[], usage: Readonly<Record<string, UsageRecord>>): Record<string, UsageRecord> {
  const supersedesOf = new Map<number, string>()
  for (const doc of docs) {
    for (const entry of doc.history) if (entry.supersedes) supersedesOf.set(entry.seq, entry.supersedes)
    for (const section of doc.sections) for (const entry of section.entries) if (entry.supersedes) supersedesOf.set(entry.seq, entry.supersedes)
  }
  const out: Record<string, UsageRecord> = { ...usage }
  for (const doc of docs) {
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        if (!entry.supersedes) continue
        const own = usage[String(entry.seq)]
        let count = own?.count ?? 0
        let last = own?.last ?? ''
        const seen = new Set<number>([entry.seq])
        const queue = expandSeqRange(entry.supersedes)
        while (queue.length > 0) {
          const seq = queue.pop()!
          if (seen.has(seq)) continue
          seen.add(seq)
          const row = usage[String(seq)]
          if (row !== undefined) {
            count += Number.isFinite(row.count) ? Math.max(0, row.count) : 0
            if (typeof row.last === 'string' && row.last > last) last = row.last
          }
          const earlier = supersedesOf.get(seq)
          if (earlier !== undefined) queue.push(...expandSeqRange(earlier))
        }
        if (count !== (own?.count ?? 0) || last !== (own?.last ?? '')) out[String(entry.seq)] = { last, count }
      }
    }
  }
  return out
}

export function recallUsage(dir: string): Record<string, UsageRecord> {
  return flowedUsage([...listTopicDocs(dir), ...listArchiveDocs(dir)], readUsage(dir))
}

function newestRuling(rows: readonly RulingRecord[]): RulingRecord | undefined {
  let best: RulingRecord | undefined
  for (const r of rows) if (best === undefined || r.time > best.time || (r.time === best.time && r.seq > best.seq)) best = r
  return best
}

export function currentRuling(ctx: FootnoteContext, sessionId: string): string | undefined {
  const ordinal = sessionOrdinal(sessionId, ctx.sessions)
  const own = ordinal === undefined ? undefined : newestRuling(ctx.rulings.filter(r => r.ordinal === ordinal))
  const pick = own ?? newestRuling(ctx.rulings)
  return pick === undefined ? undefined : `seq:${pick.seq}`
}

export function rulingLinkedIds(pool: readonly LookupCandidate[], ruling: string, ctx: FootnoteContext, dir: string): Set<string> {
  const entries = new Map<number, MnemeEntry>()
  for (const doc of [...listTopicDocs(dir), ...listArchiveDocs(dir)]) for (const section of doc.sections) for (const entry of section.entries) entries.set(entry.seq, entry)
  const pending = new Map(pendingRows(dir).map(row => [`pending:${row.ts}`, row]))
  const linked = new Set<string>()
  for (const candidate of pool) {
    const entry = candidate.seq !== undefined ? entries.get(candidate.seq) : undefined
    const row = entry === undefined ? pending.get(candidate.id) : undefined
    const made = entry ?? (row !== undefined ? { seq: 0, time: row.ts, source: row.source } : undefined)
    if (made !== undefined && footnotesOf(made, ctx).ruling === ruling) linked.add(candidate.id)
  }
  return linked
}

export function liftRulingLinks(order: readonly string[], pool: readonly LookupCandidate[], dir: string, opts: { sessions?: readonly LedgerEntry[]; sessionId?: string } = {}): string[] {
  try {
    const ctx = footnoteContext(dir, opts.sessions ?? currentLedger())
    const ruling = currentRuling(ctx, opts.sessionId ?? String(getSessionId()))
    if (ruling === undefined) return [...order]
    const ranked = new Set(order)
    const linked = rulingLinkedIds(pool.filter(candidate => ranked.has(candidate.id)), ruling, ctx, dir)
    return linked.size === 0 ? [...order] : liftLinked(order, linked)
  } catch {
    return [...order]
  }
}
