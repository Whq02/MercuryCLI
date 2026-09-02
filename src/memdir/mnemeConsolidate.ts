/* ============================================================================
   MNEME consolidation — CURRENT → topic docs, through a deterministic
   post-validator (see mnemeGates.ts; arXiv:2606.10677 §consolidation).

   The rewriter is INJECTED (the executor makeHooks idiom): an LLM may group,
   dedupe, mark supersedes with seq ranges, and apply explicit recency rules —
   but its draft only lands if the validator proves it lossless. The DEFAULT
   rewriter is deterministic verbatim-grouping by topic hint: trivially
   faithful, so the subsystem is fully live with zero LLM dependency.

   THE VALIDATOR (the anti-gaming spine; every rule is set arithmetic over
   signatures):
     1. no invention — every draft entry's seq was assigned from THIS batch;
     2. conservation — every input seq appears EXACTLY ONCE: as a live draft
        entry, or named in exactly one entry's supersedes range (the
        superseded original is then materialized under ## history — evidence
        retained, never dropped);
     3. cue integrity — a draft entry's time+source EQUAL the input row's for
        that seq (the cues that must move with entries can't be rewritten);
     4. supersedes references resolve: batch seqs or live seqs already in the
        library (revising an existing doc fact moves it to history);
     5. shape — slugs slug-safe, texts non-empty.
   A refused draft leaves CURRENT untouched (nothing is lost; the refusal
   reason is returned and the deterministic fallback can be run instead).

   Trigger (maybeConsolidate): force, OR buffer ≥ CONSOLIDATE_TOKENS, OR age
   of oldest buffered row ≥ CONSOLIDATE_AGE_MS with a non-empty buffer.
   ============================================================================ */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { bufferTokens, currentBufferPath, readBuffer, type MnemeObservation } from './mnemeBuffer.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { durableAtomicPublishSync, renameWithWin32RetrySync } from '../substrate/durablePublish.js'
import {
  HISTORY_HEADING,
  MAX_DOC_TOKENS,
  MIN_DOC_TOKENS,
  applyRevision,
  computeDocTokens,
  docFileName,
  emptyDoc,
  expandSeqRange,
  liveSeqs,
  mergeDocs,
  parseTopicDoc,
  pickMergePartner,
  serializeTopicDoc,
  slugify,
  splitDoc,
  type MnemeEntry,
  type MnemeTopicDoc,
} from './mnemeTopicDocs.js'

// Serialization hygiene at the ONE seam every rewriter (deterministic, LLM,
// legacy buffer rows) flows through: entries live on single markdown lines
// with a parsable signature, so newlines in text and `,`/`<`/`>` in source
// would write entries the parser can never see again.
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ')
const sigSafe = (s: string): string => s.replace(/[,<>\r\n]+/g, '-')

export const CONSOLIDATE_TOKENS = 5000
export const CONSOLIDATE_AGE_MS = 24 * 60 * 60 * 1000

// ── library meta (single-consolidator seq authority) ────────────────────────
interface LibraryMeta {
  version: 1
  seqCounter: number
  lastConsolidatedAt: string | null
}

export function libraryMetaPath(dir: string = mnemeLibraryDir()): string {
  return join(dir, 'library.json')
}

export function readLibraryMeta(dir: string = mnemeLibraryDir()): LibraryMeta {
  try {
    const m = JSON.parse(readFileSync(libraryMetaPath(dir), 'utf8')) as LibraryMeta
    if (typeof m?.seqCounter === 'number' && m.seqCounter >= 0) return m
  } catch {
    /* fresh */
  }
  return { version: 1, seqCounter: 0, lastConsolidatedAt: null }
}

/** Exported for mnemeCorrect.ts — the counter-first law applies there too. */
export function writeLibraryMeta(meta: LibraryMeta, dir: string): void {
  durableAtomicPublishSync(libraryMetaPath(dir), JSON.stringify(meta, null, 1))
}

// ── library io ──────────────────────────────────────────────────────────────
export function listTopicDocs(dir: string = mnemeLibraryDir()): MnemeTopicDoc[] {
  if (!existsSync(dir)) return []
  const out: MnemeTopicDoc[] = []
  for (const name of readdirSync(dir).filter(n => /^topic-.*\.md$/.test(n)).sort()) {
    try {
      const doc = parseTopicDoc(readFileSync(join(dir, name), 'utf8'))
      if (doc) out.push(doc)
    } catch {
      logForDebugging(`mneme: unreadable topic doc ${name}`)
    }
  }
  return out
}

/** Exported for mnemeCorrect.ts — one durable doc-publication primitive. */
export function writeDoc(doc: MnemeTopicDoc, dir: string): void {
  durableAtomicPublishSync(join(dir, docFileName(doc.slug)), serializeTopicDoc(doc))
}

// ── the rewriter contract ───────────────────────────────────────────────────
/** A buffered observation with its just-assigned library seq. */
export interface AssignedRow extends MnemeObservation {
  seq: number
}

export interface MnemeDraftEntry {
  text: string
  seq: number
  time: string
  source: string
  /** '12' | '12-14' | '12,14' — batch seqs or live library seqs. */
  supersedes?: string
}

export interface MnemeDraftBlock {
  topicSlug: string
  /** Used when the block creates a NEW doc. */
  summary?: string
  heading?: string
  entries: MnemeDraftEntry[]
}

export interface MnemeDraft {
  blocks: MnemeDraftBlock[]
}

export type MnemeRewriter = (input: {
  rows: readonly AssignedRow[]
  /** id+summary catalog of existing docs (routing context, never full docs). */
  catalog: ReadonlyArray<{ id: string; slug: string; summary: string }>
}) => MnemeDraft

/** The trivially-faithful default: verbatim entries grouped by topic hint. */
export const deterministicRewriter: MnemeRewriter = ({ rows }) => {
  const bySlug = new Map<string, MnemeDraftBlock>()
  for (const r of rows) {
    const slug = slugify(r.topicHint ?? 'general')
    let block = bySlug.get(slug)
    if (!block) {
      block = { topicSlug: slug, summary: r.topicHint ?? 'general notes', heading: 'notes', entries: [] }
      bySlug.set(slug, block)
    }
    block.entries.push({ text: r.text, seq: r.seq, time: r.ts, source: r.source })
  }
  return { blocks: [...bySlug.values()] }
}

// ── the deterministic post-validator ────────────────────────────────────────
export function validateDraft(
  draft: MnemeDraft,
  input: { rows: readonly AssignedRow[]; libraryLiveSeqs: ReadonlySet<number> },
): { ok: true } | { ok: false; reason: string } {
  if (!draft || !Array.isArray(draft.blocks)) return { ok: false, reason: 'draft is not {blocks[]}' }
  const bySeq = new Map(input.rows.map(r => [r.seq, r]))
  const seen = new Set<number>()
  const supersededBatch = new Map<number, number>() // batch seq → superseding seq
  const supersededLib = new Set<number>() // library-live targets — each at most once
  for (const block of draft.blocks) {
    if (typeof block.topicSlug !== 'string' || slugify(block.topicSlug) !== block.topicSlug || !block.topicSlug) {
      return { ok: false, reason: `block slug not slug-safe: '${String(block.topicSlug)}'` }
    }
    if (!Array.isArray(block.entries) || block.entries.length === 0) {
      return { ok: false, reason: `block ${block.topicSlug} has no entries` }
    }
    for (const e of block.entries) {
      const row = bySeq.get(e.seq)
      if (!row) return { ok: false, reason: `entry seq ${e.seq} was not assigned in this batch (invention)` }
      if (seen.has(e.seq)) return { ok: false, reason: `seq ${e.seq} appears twice as a live entry` }
      seen.add(e.seq)
      if (!e.text || typeof e.text !== 'string' || !e.text.trim()) {
        return { ok: false, reason: `seq ${e.seq} has empty text (evidence lost)` }
      }
      if (e.time !== row.ts || e.source !== row.source) {
        return { ok: false, reason: `seq ${e.seq} signature cues rewritten (time/source must move with the entry)` }
      }
      if (e.supersedes !== undefined) {
        const targets = expandSeqRange(e.supersedes)
        if (targets.length === 0) return { ok: false, reason: `seq ${e.seq} has unparseable supersedes '${e.supersedes}'` }
        for (const t of targets) {
          if (bySeq.has(t)) {
            if (t === e.seq) return { ok: false, reason: `seq ${e.seq} supersedes itself` }
            if (supersededBatch.has(t)) return { ok: false, reason: `batch seq ${t} superseded twice` }
            supersededBatch.set(t, e.seq)
          } else if (!input.libraryLiveSeqs.has(t)) {
            return { ok: false, reason: `supersedes target ${t} is neither in this batch nor live in the library` }
          } else {
            if (supersededLib.has(t)) return { ok: false, reason: `library seq ${t} superseded twice in one draft` }
            supersededLib.add(t)
          }
        }
      }
    }
  }
  for (const r of input.rows) {
    if (!seen.has(r.seq) && !supersededBatch.has(r.seq)) {
      return { ok: false, reason: `input seq ${r.seq} dropped — neither live nor explicitly superseded (conservation)` }
    }
    if (seen.has(r.seq) && supersededBatch.has(r.seq)) {
      return { ok: false, reason: `input seq ${r.seq} is both live and superseded` }
    }
  }
  return { ok: true }
}

// ── consolidation ───────────────────────────────────────────────────────────
export interface ConsolidateResult {
  consolidated: boolean
  reason: string
  docsTouched: string[]
  entries: number
  refusedDraft?: string
}

// Exclusive consolidator lock (mkdir is atomic): session + daemon may both
// hit a threshold; two concurrent consolidators would assign OVERLAPPING
// seqs from the same counter read. Loser backs off — the buffer survives and
// the winner (or the next trigger) takes it. A crash-stale lock (> 5 min) is
// stolen.
const LOCK_STALE_MS = 5 * 60 * 1000
// A DEAD holder (pid provably gone) is stealable after a short grace —
// waiting the full 5-minute window would block crash recovery for no
// benefit. A LIVE holder keeps the 5-minute descheduled-
// writer rule EXACTLY (the §STALE-STEAL-UNDER-DESCHEDULE semantics).
const LOCK_DEAD_GRACE_MS = 15 * 1000

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Exported for the correction owner (mnemeCorrect.ts): corrections assign
 *  seqs from the same counter, so they serialize under the SAME lock. */
export function acquireConsolidateLock(dir: string): boolean {
  const lock = join(dir, '.consolidate.lock')
  const take = (): boolean => {
    mkdirSync(lock)
    try {
      writeFileSync(join(lock, 'pid'), String(process.pid), 'utf8')
    } catch {
      /* pid file is advisory — the mkdir IS the lock */
    }
    return true
  }
  try {
    return take()
  } catch {
    try {
      const ageMs = Date.now() - statSync(lock).mtimeMs
      let holderDead = false
      try {
        const pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim())
        holderDead = Number.isInteger(pid) && pid > 0 && !pidAlive(pid)
      } catch {
        /* no/unreadable pid — only the 5-min rule applies */
      }
      if ((holderDead && ageMs > LOCK_DEAD_GRACE_MS) || ageMs > LOCK_STALE_MS) {
        rmSync(lock, { recursive: true, force: true })
        return take()
      }
    } catch {
      /* raced or unreadable — treat as held */
    }
    return false
  }
}

/**
 * Release iff the lock is still OURS. A holder descheduled past the stale
 * window loses the lock to a reclaimer that writes its own pid; when the
 * slow holder finally finishes, an unconditional remove would delete the
 * successor's live lock and re-open the overlapping-seq race this lock
 * exists to prevent (sweep #2 item 73). A lock directory without a
 * readable pid file is a pre-pid lock and releases as before.
 */
export function releaseConsolidateLock(dir: string): void {
  const lock = join(dir, '.consolidate.lock')
  if (!consolidateLockOwnedBy(lock, process.pid)) return
  try {
    rmSync(lock, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
}

/** Pure read of the advisory pid file; exported for the parity prover. */
export function consolidateLockOwnedBy(lock: string, pid: number): boolean {
  let raw: string
  try {
    raw = readFileSync(join(lock, 'pid'), 'utf8')
  } catch {
    return true
  }
  const holder = Number(raw.trim())
  return !Number.isInteger(holder) || holder <= 0 || holder === pid
}

/** Stable content hash for exactly-once crash recovery (FNV-1a over the
 *  observation's identity cues). */
function rowHash(r: { ts: string; source: string; text: string }): string {
  const s = `${r.ts}\u0000${r.source}\u0000${r.text}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/** Every seq present anywhere in the library (live + history). */
function allLibrarySeqs(dir: string): Set<number> {
  const out = new Set<number>()
  for (const d of listTopicDocs(dir)) {
    for (const s of d.sections) for (const e of s.entries) out.add(e.seq)
    for (const e of d.history) out.add(e.seq)
  }
  return out
}

/**
 * Consume the buffer LOSS-FREE under concurrency (the no-data-loss floor):
 * rename current.jsonl to a consuming-* file FIRST (atomic — an append racing
 * the rename lands wholly in one file or the other), then read. Stale
 * consuming-* files from a crashed consolidator are absorbed into the batch.
 * On refusal/error the caller restores every consumed file's bytes back onto
 * current.jsonl (atomic appends; row order may shift across writers — ts
 * fields preserve time, and buffer order was never a cross-writer total
 * order).
 *
 * EXACTLY-ONCE RECOVERY (at-least-once re-absorption would duplicate
 * rows): a batch MANIFEST
 * (seq + content hash per row, written counter-first alongside the meta)
 * survives a crash; rows whose hash maps to a seq ALREADY IN the library
 * landed before the crash and are dropped at re-absorption instead of being
 * re-consolidated under fresh seqs. Manifests die at the end of the next
 * successful consolidation. (Bounded known cost: while a crash manifest is
 * pending, a byte-identical re-observation of a LANDED row would be absorbed
 * into that batch's identity — acceptable for the window's rarity.)
 */
function consumeBuffer(dir: string): { files: string[]; rows: MnemeObservation[]; staleManifests: string[]; landedCount: number } {
  const files: string[] = []
  const staleManifests: string[] = []
  try {
    const names = readdirSync(dir)
    files.push(
      ...names
        .filter(n => /^consuming-.*\.jsonl$/.test(n))
        .sort()
        .map(n => join(dir, n)),
    )
    staleManifests.push(
      ...names
        .filter(n => /^batch-\d+-\d+\.json$/.test(n))
        .sort()
        .map(n => join(dir, n)),
    )
  } catch {
    /* no dir yet */
  }
  const current = currentBufferPath(dir)
  if (existsSync(current)) {
    const consuming = join(dir, `consuming-${process.pid}-${Date.now().toString(36)}.jsonl`)
    try {
      // Claim move under the win32 bounded-retry law: a transient
      // AV lock must not skip a whole consolidation cycle. Raced-away
      // (ENOENT — another consumer claimed it) still lands in the catch.
      renameWithWin32RetrySync(current, consuming)
      files.push(consuming)
    } catch {
      /* raced away — proceed with whatever we have */
    }
  }
  // Crash-manifest map: content hash → assigned seq of the crashed batch.
  const landedByHash = new Map<string, number>()
  for (const m of staleManifests) {
    try {
      const parsed = JSON.parse(readFileSync(m, 'utf8')) as { rows?: Array<{ seq: number; h: string }> }
      for (const r of parsed.rows ?? []) if (typeof r?.h === 'string' && typeof r?.seq === 'number') landedByHash.set(r.h, r.seq)
    } catch {
      logForDebugging(`mneme consumeBuffer: unreadable batch manifest ${m}`)
    }
  }
  const librarySeqs = landedByHash.size > 0 ? allLibrarySeqs(dir) : null
  const rows: MnemeObservation[] = []
  let landedCount = 0
  for (const f of files) {
    try {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as MnemeObservation
          if (typeof row?.text === 'string' && typeof row?.source === 'string' && typeof row?.ts === 'string') {
            if (librarySeqs) {
              const seq = landedByHash.get(rowHash(row))
              if (seq !== undefined && librarySeqs.has(seq)) {
                landedCount++
                continue
              }
            }
            rows.push(row)
          }
        } catch {
          logForDebugging('mneme consumeBuffer: skipped malformed row')
        }
      }
    } catch {
      /* unreadable file — leave it for restore */
    }
  }
  if (landedCount > 0) logForDebugging(`mneme consumeBuffer: ${landedCount} row(s) already landed pre-crash (manifest dedup)`)
  return { files, rows, staleManifests, landedCount }
}

function restoreConsumed(dir: string, files: string[]): void {
  for (const f of files) {
    try {
      appendFileSync(currentBufferPath(dir), readFileSync(f, 'utf8'), 'utf8')
      unlinkSync(f)
    } catch (e) {
      // Restore failed: the consuming file REMAINS on disk (absorbed by the
      // next consolidation) — degraded, never lost.
      logForDebugging(`mneme restoreConsumed left ${f} in place: ${String(e)}`)
    }
  }
}

export function maybeConsolidate(
  opts: {
    rewriter?: MnemeRewriter
    force?: boolean
    dir?: string
    now?: Date
  } = {},
): ConsolidateResult {
  const none = (reason: string): ConsolidateResult => ({ consolidated: false, reason, docsTouched: [], entries: 0 })
  if (!mnemeEnabled()) return none('mneme off')
  const dir = opts.dir ?? mnemeLibraryDir()
  // Threshold peek BEFORE consuming anything (below-threshold calls must be
  // side-effect-free). Stale consuming-* leftovers force due (crash recovery).
  const peek = readBuffer(dir)
  let staleConsuming = false
  try {
    staleConsuming = readdirSync(dir).some(n => /^consuming-.*\.jsonl$/.test(n))
  } catch {
    /* no dir */
  }
  if (peek.length === 0 && !staleConsuming) return none('buffer empty')
  const now = opts.now ?? new Date()
  if (!opts.force && !staleConsuming) {
    const oldest = Date.parse(peek[0]!.ts)
    const dueBySize = bufferTokens(dir) >= CONSOLIDATE_TOKENS
    const dueByAge = Number.isFinite(oldest) && now.getTime() - oldest >= CONSOLIDATE_AGE_MS
    if (!dueBySize && !dueByAge) return none('below thresholds')
  }
  if (!acquireConsolidateLock(dir)) return none('consolidation in progress (lock held)')
  let consumed: { files: string[]; rows: MnemeObservation[]; staleManifests: string[]; landedCount: number } = { files: [], rows: [], staleManifests: [], landedCount: 0 }
  try {
    consumed = consumeBuffer(dir)
    const rows = consumed.rows
    if (rows.length === 0) {
      if (consumed.landedCount > 0) {
        // Every consumed row already landed pre-crash (the batch COMPLETED,
        // only cleanup died): finish the cleanup — restoring here would
        // resurrect landed rows into CURRENT as duplicates (the exactly-once
        // violation).
        for (const f of [...consumed.files, ...consumed.staleManifests]) {
          try {
            unlinkSync(f)
          } catch {
            /* already gone */
          }
        }
        return none('crashed batch had fully landed; cleanup completed')
      }
      restoreConsumed(dir, consumed.files)
      return none('buffer empty')
    }
    const meta = readLibraryMeta(dir)
    const assigned: AssignedRow[] = rows.map((r, i) => ({ ...r, seq: meta.seqCounter + 1 + i }))
    const docs = listTopicDocs(dir)
    const catalog = docs.map(d => ({ id: d.id, slug: d.slug, summary: d.summary }))
    const libraryLive = new Set<number>()
    for (const d of docs) for (const s of liveSeqs(d)) libraryLive.add(s)

    const rewriter = opts.rewriter ?? deterministicRewriter
    const draft = rewriter({ rows: assigned, catalog })
    const verdict = validateDraft(draft, { rows: assigned, libraryLiveSeqs: libraryLive })
    if (!verdict.ok) {
      // Refused: every consumed row goes BACK to CURRENT (atomic appends) —
      // nothing lost; the caller may retry with the deterministic rewriter.
      restoreConsumed(dir, consumed.files)
      return { ...none(`draft refused: ${verdict.reason}`), refusedDraft: verdict.reason }
    }

    const nowIso = now.toISOString()
    // Persist the bumped counter BEFORE any doc mutation: a crash mid-write
    // then re-absorbs consuming-* rows under FRESH seqs (duplicate content at
    // worst — the documented tradeoff), never re-issues the SAME seqs into
    // different docs (which would corrupt every supersedes reference). Holes
    // in the sequence are fine; collisions are not.
    writeLibraryMeta(
      { version: 1, seqCounter: meta.seqCounter + assigned.length, lastConsolidatedAt: nowIso },
      dir,
    )
    // Batch manifest (exactly-once recovery): written AFTER the counter,
    // BEFORE any doc mutation. A crash from here on is recoverable without
    // duplication — re-absorption drops rows whose hash+seq already landed.
    const manifestPath = join(dir, `batch-${meta.seqCounter + 1}-${meta.seqCounter + assigned.length}.json`)
    durableAtomicPublishSync(
      manifestPath,
      JSON.stringify({ version: 1, rows: assigned.map(r => ({ seq: r.seq, h: rowHash(r) })) }),
    )
    const byId = new Map(docs.map(d => [d.slug, d]))
    const bySeq = new Map(assigned.map(r => [r.seq, r]))
    const supersededBatchSeqs = new Set<number>()
    for (const block of draft.blocks) {
      for (const e of block.entries) {
        for (const t of e.supersedes ? expandSeqRange(e.supersedes) : []) {
          if (bySeq.has(t)) supersededBatchSeqs.add(t)
        }
      }
    }
    const touched = new Set<string>()
    let entries = 0
    for (const block of draft.blocks) {
      let doc = byId.get(block.topicSlug)
      if (!doc) {
        doc = emptyDoc(block.topicSlug, block.summary ?? block.topicSlug.replace(/-/g, ' '), nowIso)
        byId.set(block.topicSlug, doc)
      }
      let heading = oneLine(block.heading ?? '').trim() || 'notes'
      // `## history` is the parser's reserved section — a rewriter-chosen
      // heading colliding with it would silently demote live entries to
      // history on the next parse.
      if (heading.toLowerCase() === HISTORY_HEADING) heading = 'notes'
      for (const e of block.entries) {
        const entry: MnemeEntry = { text: oneLine(e.text).trim(), seq: e.seq, time: e.time, source: sigSafe(e.source).trim(), supersedes: e.supersedes }
        const applied = applyRevision(doc, entry, heading)
        entries++
        const handled = new Set(applied.superseded)
        // A superseded BATCH row never becomes a live entry — materialize the
        // original under history so its evidence is retained (conservation's
        // other half; same-doc in-library targets were moved by applyRevision).
        for (const t of e.supersedes ? expandSeqRange(e.supersedes) : []) {
          const origin = bySeq.get(t)
          if (origin && supersededBatchSeqs.has(t)) {
            doc.history.push({ text: oneLine(origin.text).trim(), seq: t, time: origin.ts, source: sigSafe(origin.source).trim(), supersededBy: e.seq })
            supersededBatchSeqs.delete(t)
            continue
          }
          // Cross-doc supersede: the validator accepts any library-LIVE
          // target, but applyRevision only moves targets inside THIS doc —
          // complete the promised move-to-history in the holder doc.
          if (bySeq.has(t) || handled.has(t)) continue
          for (const [otherSlug, other] of byId) {
            if (other === doc || !liveSeqs(other).has(t)) continue
            for (const s of other.sections) {
              const at = s.entries.findIndex(x => x.seq === t)
              if (at >= 0) {
                other.history.push({ ...s.entries[at]!, supersededBy: e.seq })
                s.entries.splice(at, 1)
                break
              }
            }
            other.updated = nowIso
            other.updateLog.push(`${nowIso} seq ${t} superseded by ${e.seq} (in topic-${doc.slug})`)
            touched.add(otherSlug)
            break
          }
        }
      }
      doc.updated = nowIso
      doc.updateLog.push(`${nowIso} +${block.entries.length} entr${block.entries.length === 1 ? 'y' : 'ies'} (seq ${block.entries[0]!.seq}–${block.entries[block.entries.length - 1]!.seq})`)
      touched.add(doc.slug)
    }

    // Structural maintenance (P3's asymmetry: split before merge).
    mkdirSync(dir, { recursive: true })
    for (const slug of [...touched]) {
      const doc = byId.get(slug)!
      if (computeDocTokens(doc) > MAX_DOC_TOKENS) {
        const split = splitDoc(doc, nowIso, new Set(byId.keys()))
        if (split) {
          byId.set(split[0].slug, split[0])
          byId.set(split[1].slug, split[1])
          touched.add(split[0].slug)
          touched.add(split[1].slug)
        }
      }
    }
    for (const slug of [...touched]) {
      const doc = byId.get(slug)
      if (!doc || computeDocTokens(doc) >= MIN_DOC_TOKENS) continue
      const partner = pickMergePartner(doc, [...byId.values()])
      if (partner) {
        mergeDocs(partner, doc, nowIso)
        byId.delete(slug)
        touched.delete(slug)
        touched.add(partner.slug)
        const stale = join(dir, docFileName(slug))
        if (existsSync(stale)) unlinkSync(stale)
      }
    }

    for (const slug of touched) {
      const doc = byId.get(slug)
      if (doc) writeDoc(doc, dir)
    }
    // (library meta was persisted BEFORE doc mutation — seq-collision safety.)
    // Drop the CONSUMED files last — rows appended concurrently sit in a
    // fresh current.jsonl untouched by this batch. A crash before this point
    // leaves consuming-* files that the next run absorbs (duplicated into
    // docs at worst, never lost).
    for (const f of consumed.files) {
      try {
        unlinkSync(f)
      } catch {
        /* already gone */
      }
    }
    // Manifests die after the consumed files: this batch's own manifest and
    // any crashed batch's stale manifests (their rows are now either landed
    // or re-consolidated).
    for (const m of [manifestPath, ...consumed.staleManifests]) {
      try {
        unlinkSync(m)
      } catch {
        /* already gone */
      }
    }
    return { consolidated: true, reason: 'ok', docsTouched: [...touched].sort(), entries }
  } catch (e) {
    logForDebugging(`mneme consolidate failed: ${String(e)}`)
    restoreConsumed(dir, consumed.files)
    return none(`error: ${String(e).slice(0, 120)}`)
  } finally {
    releaseConsolidateLock(dir)
  }
}
