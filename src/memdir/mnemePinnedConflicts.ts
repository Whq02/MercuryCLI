import { listArchiveDocs, listTopicDocs, writeDoc } from './mnemeLibrary.js'
import type { MnemeEntry, MnemeTopicDoc } from './mnemeTopicDocs.js'
import { movePin, readPins, type PinRecord } from './mnemeUsage.js'

export const CONFLICT_OVERLAP = 0.6

export function ruleTokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_./-]{2,}/g)) out.add(m[0])
  return out
}

export function rulesOverlap(a: string, b: string): number {
  const ta = ruleTokens(a)
  const tb = ruleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

interface Holder {
  doc: MnemeTopicDoc
  heading: string
  entry: MnemeEntry
}

function findLive(seq: number, docs: readonly MnemeTopicDoc[]): Holder | null {
  for (const doc of docs) {
    for (const s of doc.sections) {
      const entry = s.entries.find(e => e.seq === seq)
      if (entry) return { doc, heading: s.heading, entry }
    }
  }
  return null
}

export interface ConflictResolution {
  replaced: Array<{ older: number; newer: number }>
  kept: Array<{ older: number; newer: number; reason: 'older-asked' }>
}

export function resolvePinnedConflicts(dir: string, newSeqs: readonly number[], now: Date): ConflictResolution {
  const result: ConflictResolution = { replaced: [], kept: [] }
  if (newSeqs.length === 0) return result
  const docs = [...listTopicDocs(dir), ...listArchiveDocs(dir)]
  const touched = new Set<MnemeTopicDoc>()
  const nowIso = now.toISOString()
  for (const newSeq of newSeqs) {
    let pins: PinRecord[] = readPins(dir)
    const newPin = pins.find(p => p.seq === newSeq)
    const newer = findLive(newSeq, docs)
    if (!newPin || !newer) continue
    const candidates = pins
      .filter(p => p.seq !== newSeq && !newSeqs.includes(p.seq))
      .map(p => ({ pin: p, holder: findLive(p.seq, docs) }))
      .filter((c): c is { pin: PinRecord; holder: Holder } => c.holder !== null)
      .map(c => ({ ...c, overlap: rulesOverlap(c.holder.entry.text, newer.entry.text) }))
      .filter(c => c.overlap >= CONFLICT_OVERLAP)
      .sort((a, b) => b.overlap - a.overlap)
    const older = candidates[0]
    if (!older) continue
    if (older.pin.asked && !newPin.asked) {
      result.kept.push({ older: older.pin.seq, newer: newSeq, reason: 'older-asked' })
      continue
    }
    const section = older.holder.doc.sections.find(s => s.heading === older.holder.heading)
    if (!section) continue
    const at = section.entries.indexOf(older.holder.entry)
    if (at < 0) continue
    section.entries.splice(at, 1)
    older.holder.doc.history.push({ ...older.holder.entry, supersededBy: newSeq })
    older.holder.doc.updated = nowIso
    older.holder.doc.updateLog.push(`${nowIso} pinned rule seq ${older.pin.seq} replaced in place by seq ${newSeq} (a newer rule on the same matter)`)
    touched.add(older.holder.doc)
    newer.entry.supersedes = newer.entry.supersedes ? `${newer.entry.supersedes},${older.pin.seq}` : String(older.pin.seq)
    newer.doc.updated = nowIso
    newer.doc.updateLog.push(`${nowIso} seq ${newSeq} replaces pinned rule seq ${older.pin.seq}`)
    touched.add(newer.doc)
    movePin(older.pin.seq, newSeq, dir, newPin.asked === true)
    pins = readPins(dir)
    result.replaced.push({ older: older.pin.seq, newer: newSeq })
  }
  for (const doc of touched) writeDoc(doc, dir)
  return result
}
