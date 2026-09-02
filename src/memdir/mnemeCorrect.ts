/* ============================================================================
   MNEME corrections — first-class supersede/retire by stable seq.

   This module is the ONE correction owner — the one production path that
   emits a `supersedes` (applyRevision + validator rule 4 + history
   retention): the MCP verbs, the Memory Centre and any maintenance path
   all route here.

   Laws (mechanically re-checked):
   - corrections serialize under the SAME consolidator lock (seq authority);
   - the counter is persisted BEFORE any doc mutation (collision-safety);
   - a correction draft passes the SAME deterministic validator as any
     rewriter draft before it lands;
   - the superseded original is RETAINED under `## history` with its original
     signature, stamped `[superseded-by N]` — evidence is never destroyed;
   - two concurrent corrections of one target resolve deterministically:
     the lock serializes them and the loser gets a typed `already-superseded`;
   - a crash between counter-persist and the doc write loses only the NEW
     correction (a seq hole, reported as an error to the caller who retries)
     — it can never corrupt or duplicate existing records.
   ============================================================================ */

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

/** Locate the LIVE holder of a seq, or its history record. */
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

/** Post-write self-check: the doc on disk shows the correction landed. */
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

/**
 * Correct a current fact: a NEW entry (fresh seq, its own time/source, an
 * explicit `supersedes=<target>`) replaces the target in its own section;
 * the target moves to `## history`.
 */
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
    // The SAME validator every rewriter draft passes — mechanically proves
    // no-invention / conservation / cue integrity / supersedes resolution.
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

/**
 * Retire a current fact (no replacement): the target moves to `## history`
 * stamped with the retirement seq; the retirement record itself lands in
 * history too (`retired: <reason>`, `supersedes=<target>`) so nothing stays
 * live and the whole act is inspectable.
 */
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
    // Move the target to history via the same machinery…
    const tombstone: MnemeEntry = {
      text: `retired: ${reason} (was: ${target.text.slice(0, 120)})`,
      seq: newSeq,
      time: nowIso,
      source,
      supersedes: String(input.targetSeq),
    }
    applyRevision(doc, tombstone, heading)
    // …then take the tombstone itself out of the live section: retire means
    // NOTHING stays current. It keeps its signature in history.
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
