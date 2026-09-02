


import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import {
  acquireConsolidateLock,
  listTopicDocs,
  readLibraryMeta,
  releaseConsolidateLock,
  validateDraft,
  writeLibraryMeta,
  writeDoc,
} from './mnemeConsolidate.js'
import {
  applyRevision,
  docFileName,
  liveSeqs,
  parseTopicDoc,
  type MnemeEntry,
  type MnemeTopicDoc,
} from './mnemeTopicDocs.js'

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const sigSafe = (s: string): string => s.replace(/[,<>\r\n]+/g, '-')

export type MnemeCorrectResult =
  | { ok: true; action: 'corrected' | 'retired'; seq: number; targetSeq: number; slug: string }
  | {
      ok: false
      code: 'off' | 'unknown-target' | 'already-superseded' | 'busy' | 'invalid' | 'error'
      message: string
      supersededBy?: number
    }

interface Holder {
  doc: MnemeTopicDoc
  heading: string
  entry: MnemeEntry
}

function findTarget(
  targetSeq: number,
  dir: string,
): { live?: Holder; history?: { slug: string; supersededBy?: number } } {
  for (const doc of listTopicDocs(dir)) {
    for (const s of doc.sections) {
      const entry = s.entries.find(e => e.seq === targetSeq)
      if (entry) return { live: { doc, heading: s.heading, entry } }
    }
    const h = doc.history.find(e => e.seq === targetSeq)
    if (h) return { history: { slug: doc.slug, supersededBy: h.supersededBy } }
  }
  return {}
}

function verifyLanded(dir: string, slug: string, newSeq: number, targetSeq: number, expectLive: boolean): boolean {
  try {
    const p = join(dir, docFileName(slug))
    if (!existsSync(p)) return false
    const doc = parseTopicDoc(readFileSync(p, 'utf8'))
    if (!doc) return false
    const liveHasNew = liveSeqs(doc).has(newSeq)
    const hist = doc.history.find(e => e.seq === targetSeq)
    return (expectLive ? liveHasNew : !liveSeqs(doc).has(targetSeq)) && !!hist && hist.supersededBy === newSeq
  } catch {
    return false
  }
}

export function correctFact(input: {
  targetSeq: number
  text: string
  source: string
  dir?: string
  now?: Date
}): MnemeCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'MNEME is disabled (MERCURY_MNEME is not on).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const text = oneLine(String(input.text ?? '')).trim()
  const source = sigSafe(String(input.source ?? '')).trim()
  if (!text || !source) return { ok: false, code: 'invalid', message: 'correction needs non-empty text and source' }
  if (!Number.isInteger(input.targetSeq) || input.targetSeq < 1) {
    return { ok: false, code: 'invalid', message: `targetSeq must be a positive integer, got ${String(input.targetSeq)}` }
  }
  if (!acquireConsolidateLock(dir)) {
    return { ok: false, code: 'busy', message: 'a consolidation/correction is in progress — retry in a moment' }
  }
  try {
    const found = findTarget(input.targetSeq, dir)
    if (!found.live) {
      if (found.history) {
        return {
          ok: false,
          code: 'already-superseded',
          message: `seq ${input.targetSeq} is history in topic-${found.history.slug}${found.history.supersededBy ? ` (superseded by ${found.history.supersededBy})` : ''} — correct the CURRENT entry instead`,
          supersededBy: found.history.supersededBy,
        }
      }
      return { ok: false, code: 'unknown-target', message: `seq ${input.targetSeq} is not in this library` }
    }
    const { doc, heading } = found.live
    const meta = readLibraryMeta(dir)
    const newSeq = meta.seqCounter + 1
    const nowIso = (input.now ?? new Date()).toISOString()
    const draftRow = { ts: nowIso, source, text, topicHint: doc.slug, seq: newSeq }
    const libraryLive = new Set<number>()
    for (const d of listTopicDocs(dir)) for (const s of liveSeqs(d)) libraryLive.add(s)
    const verdict = validateDraft(
      { blocks: [{ topicSlug: doc.slug, heading, entries: [{ text, seq: newSeq, time: nowIso, source, supersedes: String(input.targetSeq) }] }] },
      { rows: [draftRow], libraryLiveSeqs: libraryLive },
    )
    if (!verdict.ok) return { ok: false, code: 'invalid', message: `correction draft refused: ${verdict.reason}` }

    writeLibraryMeta({ version: 1, seqCounter: newSeq, lastConsolidatedAt: meta.lastConsolidatedAt }, dir)
    const entry: MnemeEntry = { text, seq: newSeq, time: nowIso, source, supersedes: String(input.targetSeq) }
    applyRevision(doc, entry, heading)
    doc.updated = nowIso
    doc.updateLog.push(`${nowIso} corrected seq ${input.targetSeq} → ${newSeq}`)
    writeDoc(doc, dir)
    if (!verifyLanded(dir, doc.slug, newSeq, input.targetSeq, true)) {
      return { ok: false, code: 'error', message: 'post-write verification failed — the correction may not have landed; re-read and retry' }
    }
    return { ok: true, action: 'corrected', seq: newSeq, targetSeq: input.targetSeq, slug: doc.slug }
  } catch (e) {
    return { ok: false, code: 'error', message: String(e).slice(0, 200) }
  } finally {
    releaseConsolidateLock(dir)
  }
}

export function retireFact(input: {
  targetSeq: number
  reason: string
  source: string
  dir?: string
  now?: Date
}): MnemeCorrectResult {
  if (!mnemeEnabled()) return { ok: false, code: 'off', message: 'MNEME is disabled (MERCURY_MNEME is not on).' }
  const dir = input.dir ?? mnemeLibraryDir()
  const reason = oneLine(String(input.reason ?? '')).trim()
  const source = sigSafe(String(input.source ?? '')).trim()
  if (!reason || !source) return { ok: false, code: 'invalid', message: 'retire needs a non-empty reason and source' }
  if (!Number.isInteger(input.targetSeq) || input.targetSeq < 1) {
    return { ok: false, code: 'invalid', message: `targetSeq must be a positive integer, got ${String(input.targetSeq)}` }
  }
  if (!acquireConsolidateLock(dir)) {
    return { ok: false, code: 'busy', message: 'a consolidation/correction is in progress — retry in a moment' }
  }
  try {
    const found = findTarget(input.targetSeq, dir)
    if (!found.live) {
      if (found.history) {
        return {
          ok: false,
          code: 'already-superseded',
          message: `seq ${input.targetSeq} is already history in topic-${found.history.slug}`,
          supersededBy: found.history.supersededBy,
        }
      }
      return { ok: false, code: 'unknown-target', message: `seq ${input.targetSeq} is not in this library` }
    }
    const { doc, heading, entry: target } = found.live
    const meta = readLibraryMeta(dir)
    const newSeq = meta.seqCounter + 1
    const nowIso = (input.now ?? new Date()).toISOString()
    writeLibraryMeta({ version: 1, seqCounter: newSeq, lastConsolidatedAt: meta.lastConsolidatedAt }, dir)
    const tombstone: MnemeEntry = {
      text: `retired: ${reason} (was: ${target.text.slice(0, 120)})`,
      seq: newSeq,
      time: nowIso,
      source,
      supersedes: String(input.targetSeq),
    }
    applyRevision(doc, tombstone, heading)
    const section = doc.sections.find(s => s.heading === heading)
    if (section) {
      const at = section.entries.findIndex(e => e.seq === newSeq)
      if (at >= 0) {
        doc.history.push(section.entries[at]!)
        section.entries.splice(at, 1)
      }
    }
    doc.updated = nowIso
    doc.updateLog.push(`${nowIso} retired seq ${input.targetSeq} (${reason.slice(0, 60)})`)
    writeDoc(doc, dir)
    if (!verifyLanded(dir, doc.slug, newSeq, input.targetSeq, false)) {
      return { ok: false, code: 'error', message: 'post-write verification failed — the retirement may not have landed; re-read and retry' }
    }
    return { ok: true, action: 'retired', seq: newSeq, targetSeq: input.targetSeq, slug: doc.slug }
  } catch (e) {
    return { ok: false, code: 'error', message: String(e).slice(0, 200) }
  } finally {
    releaseConsolidateLock(dir)
  }
}
