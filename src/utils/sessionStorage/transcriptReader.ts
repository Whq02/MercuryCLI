// ============================================================================
//  sessionStorage/transcriptReader — the ONE transcript reader.
//
//  A transcript file has one reader per path in this process. The reader
//  keeps the byte offset its fold has consumed, the fold itself, and a
//  window of the bytes just before the offset that proves the covered
//  prefix is still the prefix. A growth read fetches ONLY the bytes past
//  the offset and folds them as new rows; a truncation (size < offset), a
//  replaced file (inode change) or a rewritten window resets to the full
//  read — the same ladder a cold load takes (snapshot-plus-tail, the
//  big-file strategies, the plain read). Every consumer asks the reader for
//  what it needs — the fold, the conversation chain since its cursor, the
//  complete lines past a byte cursor, the newest lines backward — never
//  the file.
//
//  Retention: a long-lived reader (the focused chat's connector) retains
//  its path; unretained states ride a short most-recent list so a repeated
//  one-shot load (the resume picker's preview, a resume followed by the
//  connector's first tick) stays warm without holding every transcript
//  this process ever opened.
//
//  The resume snapshot beside the transcript stays the ONE cross-process
//  accelerator with its one writer; growth here refreshes it at the cadence
//  the tail-merge road always used (once per MB folded, clean tails only).
//
//  Kill switch: MERCURY_TRANSCRIPT_READER=0 (registered, default-on) —
//  every read then takes the cold ladder: byte-identical results, the
//  whole-file cost on every growth.
// ============================================================================
import type { UUID } from 'crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { decodeTranscriptBuffer } from '../../fabric/transcriptDecode.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import type { Entry, SerializedMessage, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../debug.js'
import { parseJSONL } from '../json.js'
import { logError } from '../log.js'
import {
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from '../sessionStoragePortable.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildConversationChain,
  findLatestMessage,
  removeExtraFields,
} from './chain.js'
import { applyTranscriptEntry, emptyFoldState, type TranscriptFoldState } from './fold.js'
import { isTranscriptMessage } from './paths.js'
import {
  resumeSnapshotEnabled,
  SNAPSHOT_MIN_BYTES,
  tryLoadResumeSnapshot,
  writeResumeSnapshot,
} from './resumeSnapshot.js'

/** The bytes kept from just before the consumed offset: a growth read
 *  re-reads them and a mismatch proves the covered prefix was rewritten
 *  (the resume snapshot's digest law, held as the bytes themselves). */
const WINDOW_BYTES = 4096
/** Unretained states kept warm, most recent last. */
const RECENT_MAX = 2
/** Growth folded since the last snapshot write before the next refresh —
 *  the cadence the snapshot-plus-tail road always used. */
const SNAPSHOT_REFRESH_BYTES = 1024 * 1024
/** The backward scan's first window; it widens by four until a line is
 *  found or the whole file is in view. */
const BACKWARD_WINDOW_BYTES = 64 * 1024
/** A torn final line longer than this is not looked for by the big-file
 *  road's tail scan (no real record is that long unterminated). */
const FRAGMENT_SCAN_MAX = 16 * 1024 * 1024
const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)

export function transcriptReaderEnabled(): boolean {
  return flagEnabled('MERCURY_TRANSCRIPT_READER')
}

// ── the io seam (a prover injects a counting twin) ──────────────────────────

export interface TranscriptReaderIo {
  /** size + inode, or null when the file does not exist. */
  statSync(path: string): { size: number; ino: number } | null
  /** The bytes of [start, end) — possibly short when the file shrank. */
  readRangeSync(path: string, start: number, end: number): Buffer
}

export const nodeTranscriptReaderIo: TranscriptReaderIo = {
  statSync(path) {
    try {
      const st = statSync(path)
      return { size: st.size, ino: st.ino }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw e
    }
  },
  readRangeSync(path, start, end) {
    const len = Math.max(0, end - start)
    const buf = Buffer.allocUnsafe(len)
    const fd = openSync(path, 'r')
    try {
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read)
        if (n === 0) break
        read += n
      }
      // Only the bytes actually read — never the allocation's leftovers.
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  },
}

let io: TranscriptReaderIo = nodeTranscriptReaderIo

/** TEST-ONLY: swap the io seam (null restores the node one). */
export function setTranscriptReaderIoForTesting(next: TranscriptReaderIo | null): void {
  io = next ?? nodeTranscriptReaderIo
}

// ── the load-degradation fact ───────────────────────────────────────────────
// Malformed and shape-invalid records are classified and the fold proceeds
// on the valid set — but a fact that reaches the debug log alone is one the
// operator never sees, and a whole-file refusal that resumes EMPTY silently
// leaves a session looking like it had no history. Every damaged read (a
// cold read's refusal or classification, a growth read's classification)
// latches this small subscribable fact; the chat paints it as one sticky
// notification. Latched, not consumed: the surface reads the current fact
// at mount and subscribes for later reads. Nothing here touches bytes.

export type TranscriptLoadDegradation = {
  path: string
  malformed: number
  invalid: number
  totalLines: number
  /** The whole-file refusal sentence when the load resumed EMPTY; null for
   *  a partial degradation (the valid records loaded). */
  refusal: string | null
}

let loadDegradation: TranscriptLoadDegradation | null = null
const degradationListeners = new Set<() => void>()

function noteLoadDegradation(next: TranscriptLoadDegradation): void {
  loadDegradation = next
  for (const listener of degradationListeners) {
    try {
      listener()
    } catch {
      /* a listener must never break a read */
    }
  }
}

export function transcriptLoadDegradation(): TranscriptLoadDegradation | null {
  return loadDegradation
}

export function subscribeTranscriptLoadDegradation(listener: () => void): () => void {
  degradationListeners.add(listener)
  return () => {
    degradationListeners.delete(listener)
  }
}

/** TEST-ONLY: reset the latch (proof harnesses). */
export function _resetTranscriptLoadDegradationForTesting(): void {
  loadDegradation = null
}

/** PROOF CENSUS (operation-shaped, never a wall clock): cold reads (the
 *  full ladder), growth reads (appended bytes only), resets (a growth read
 *  that found the prefix gone), bytes fetched, chain derivations. */
export const transcriptReaderCensus = {
  coldReads: 0,
  growthReads: 0,
  resets: 0,
  bytesRead: 0,
  chainDerivations: 0,
}

// ── the read contract ───────────────────────────────────────────────────────

/** 'resume' takes every acceleration (the snapshot road, dead-branch
 *  pruning on big files); 'all' keeps every leaf and reads the file plain
 *  (the shape a branch-by-branch listing wants). */
export type TranscriptReadPolicy = 'resume' | 'all'

export interface TranscriptReadAccounting {
  malformed: number
  invalid: number
  totalLines: number
}

/** What ONE read did: a cold read decoded the whole ladder's bytes, a
 *  growth read the appended complete lines, 'none' nothing (the file did
 *  not move). The accounting is that read's own, so a latch can state a
 *  degradation exactly once per damaged read. */
export interface TranscriptRead {
  kind: 'cold' | 'growth' | 'none'
  accounting: TranscriptReadAccounting
  /** The whole-file format refusal — set on the cold read that refused,
   *  sticky on the state for the generation. */
  refusal: string | null
}

export interface TranscriptView {
  path: string
  /** Bumps on every cold read — a cursor from another generation is stale. */
  generation: number
  /** Bytes the fold covers (a complete-line boundary). */
  offset: number
  /** The file size at the read. */
  size: number
  /** The reader's own fold (post-passes applied): read, never mutate. */
  fold: TranscriptFoldState
  read: TranscriptRead
  refusal: string | null
}

const ZERO_ACCOUNTING: TranscriptReadAccounting = Object.freeze({ malformed: 0, invalid: 0, totalLines: 0 })

interface ChainMemo {
  generation: number
  offset: number
  rows: readonly SerializedMessage[]
}

interface ReaderState {
  path: string
  policy: TranscriptReadPolicy
  generation: number
  offset: number
  size: number
  ino: number
  window: Buffer
  /** The cold read classified an unterminated final line as malformed; the
   *  growth read that completes it must not count it a second time. */
  tornCounted: boolean
  fold: TranscriptFoldState
  /** Dead branches were pruned before the parse: a row parenting onto an
   *  absent message means a pruned parent, and the read starts over. */
  pruned: boolean
  refusal: string | null
  bytesSinceSnapshot: number
  degradedSinceSnapshot: boolean
  chain: ChainMemo | null
}

const states = new Map<string, ReaderState>()
const retained = new Map<string, number>()
const recent: string[] = []
const inflight = new Map<string, Promise<TranscriptView>>()
let generationSeq = 0

function viewOf(state: ReaderState, read: TranscriptRead): TranscriptView {
  return {
    path: state.path,
    generation: state.generation,
    offset: state.offset,
    size: state.size,
    fold: state.fold,
    read,
    refusal: state.refusal,
  }
}

function touch(path: string): void {
  if (retained.has(path)) return
  const at = recent.indexOf(path)
  if (at !== -1) recent.splice(at, 1)
  recent.push(path)
  while (recent.length > RECENT_MAX) {
    const victim = recent.shift()!
    states.delete(victim)
  }
}

/** Pin a path's state while a long-lived reader (the chat's connector)
 *  follows it; the returned release hands it back to the recent list. */
export function retainTranscript(path: string): () => void {
  retained.set(path, (retained.get(path) ?? 0) + 1)
  const at = recent.indexOf(path)
  if (at !== -1) recent.splice(at, 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (retained.get(path) ?? 1) - 1
    if (n > 0) {
      retained.set(path, n)
      return
    }
    retained.delete(path)
    if (states.has(path)) touch(path)
  }
}

/**
 * The fold of a transcript, current as of this call. A retained or recent
 * path folds only what was appended since its last read; anything else
 * takes the cold ladder. `cache: false` reads without keeping the state
 * (a one-shot consumer that must not hold a transcript in memory).
 */
export async function readTranscript(
  path: string,
  opts?: { policy?: TranscriptReadPolicy; cache?: boolean },
): Promise<TranscriptView> {
  const policy = opts?.policy ?? 'resume'
  if (!transcriptReaderEnabled()) {
    const cold = await coldRead(path, policy)
    return viewOf(cold.state, cold.read)
  }
  // One pass per path at a time: two overlapping reads of one file would
  // both fold the same appended bytes.
  const prev = inflight.get(path) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(async (): Promise<TranscriptView> => {
    const existing = states.get(path)
    // An 'all' state serves a 'resume' ask (it is the unpruned superset);
    // a 'resume' state never serves an 'all' ask.
    const servable = existing !== undefined && existing.offset > 0 && (existing.policy === policy || existing.policy === 'all')
    if (servable) {
      const growth = growthRead(existing)
      if (growth !== null) {
        touch(path)
        return viewOf(existing, growth)
      }
    }
    const cold = await coldRead(path, policy)
    if (opts?.cache !== false && cold.state.offset > 0) {
      states.set(path, cold.state)
      touch(path)
    } else {
      states.delete(path)
    }
    return viewOf(cold.state, cold.read)
  })
  inflight.set(path, run)
  try {
    return await run
  } finally {
    if (inflight.get(path) === run) inflight.delete(path)
  }
}

function reset(state: ReaderState, why: string): null {
  transcriptReaderCensus.resets++
  logForDebugging(`transcript reader: full read of ${state.path} — ${why}`)
  states.delete(state.path)
  return null
}

function none(state: ReaderState, size: number): TranscriptRead {
  state.size = size
  return { kind: 'none', accounting: ZERO_ACCOUNTING, refusal: state.refusal }
}

/** The bytes kept from before the new offset: the last WINDOW_BYTES of the
 *  covered prefix, copied out of the read buffer so the buffer can go. */
function tailWindow(prev: Buffer, added: Buffer): Buffer {
  if (added.length >= WINDOW_BYTES) return Buffer.from(added.subarray(added.length - WINDOW_BYTES))
  const joined = Buffer.concat([prev, added])
  return joined.length > WINDOW_BYTES ? Buffer.from(joined.subarray(joined.length - WINDOW_BYTES)) : joined
}

/** Fold the bytes appended past the state's offset. Null means the prefix
 *  is no longer trustworthy (gone, replaced, truncated, rewritten, or a row
 *  parenting onto a pruned branch) and the caller takes the cold ladder. */
function growthRead(state: ReaderState): TranscriptRead | null {
  const st = io.statSync(state.path)
  if (st === null) return reset(state, 'the file is gone')
  if (st.ino !== state.ino) return reset(state, 'the file was replaced')
  if (st.size < state.offset) return reset(state, 'the file was truncated')
  if (st.size === state.offset) return none(state, st.size)
  const W = state.window.length
  const buf = io.readRangeSync(state.path, state.offset - W, st.size)
  transcriptReaderCensus.bytesRead += buf.length
  // A short read: the file shrank under the read — the next pass sees it.
  if (buf.length < W) return none(state, state.size)
  if (!buf.subarray(0, W).equals(state.window)) return reset(state, 'the covered prefix was rewritten')
  const delta = buf.subarray(W)
  const lastNl = delta.lastIndexOf(NEWLINE)
  // An append still in flight: no complete line yet — nothing to fold.
  if (lastNl === -1) return none(state, st.size)
  const complete = delta.subarray(0, lastNl + 1)
  transcriptReaderCensus.growthReads++
  let accounting: TranscriptReadAccounting = ZERO_ACCOUNTING
  if (state.refusal === null) {
    const decoded = decodeTranscriptBuffer<Entry>(complete)
    // The delta's first parseable line is foreign: the per-line
    // classification belongs to the whole-file road (a refusal is a
    // whole-file verdict, never a tail's).
    if (decoded.refusal) return reset(state, 'a line outside the record format landed')
    let malformed = decoded.malformed.length
    if (state.tornCounted && decoded.malformed.some(m => m.line === 1)) malformed -= 1
    let sawSystem = false
    for (const entry of decoded.entries) {
      if (
        state.pruned &&
        isTranscriptMessage(entry) &&
        entry.parentUuid !== null &&
        !state.fold.messages.has(entry.parentUuid) &&
        !state.fold.progressBridge.has(entry.parentUuid)
      ) {
        return reset(state, 'a row parents onto a pruned branch')
      }
      if (entry.type === 'system') sawSystem = true
      applyTranscriptEntry(state.fold, entry)
    }
    // The post-passes only ever act on boundaries (compact segments, snip
    // removals) — system rows — and are idempotent over rows already
    // relinked, so a growth without one skips them.
    if (sawSystem) {
      applyPreservedSegmentRelinks(state.fold.messages)
      applySnipRemovals(state.fold.messages)
    }
    accounting = { malformed, invalid: decoded.invalid.length, totalLines: decoded.totalLines }
    if (malformed > 0 || accounting.invalid > 0) {
      logError(
        new Error(
          `transcript tail degraded on growth: ${malformed} malformed, ${accounting.invalid} invalid of ${accounting.totalLines} (${state.path})`,
        ),
      )
      noteLoadDegradation({ path: state.path, malformed, invalid: accounting.invalid, totalLines: accounting.totalLines, refusal: null })
      state.degradedSinceSnapshot = true
    }
  }
  state.tornCounted = false
  state.offset += complete.length
  state.size = st.size
  state.window = tailWindow(state.window, complete)
  state.bytesSinceSnapshot += complete.length
  maybeRefreshSnapshot(state)
  return { kind: 'growth', accounting, refusal: state.refusal }
}

/** The write-behind at the tail-merge road's cadence: once a clean MB has
 *  folded past the last snapshot, the next process resumes O(new tail). */
function maybeRefreshSnapshot(state: ReaderState): void {
  if (state.policy !== 'resume' || state.refusal !== null) return
  if (state.bytesSinceSnapshot < SNAPSHOT_REFRESH_BYTES || state.offset < SNAPSHOT_MIN_BYTES) return
  if (state.degradedSinceSnapshot || !resumeSnapshotEnabled()) return
  writeResumeSnapshot(state.path, state.fold, state.offset)
  state.bytesSinceSnapshot = 0
}

function isCompleteJsonLine(line: Buffer): boolean {
  try {
    JSON.parse(line.toString('utf8'))
    return true
  } catch {
    return false
  }
}

/** The file's unterminated final line (bytes after its last newline), or
 *  null when the file ends on a newline — found by a widening tail scan
 *  (the big-file road's buffer is not the file's own tail). */
function fileFragment(path: string, size: number): Buffer | null {
  if (size === 0) return null
  for (let len = Math.min(size, BACKWARD_WINDOW_BYTES); ; len = Math.min(size, len * 4)) {
    const buf = io.readRangeSync(path, size - len, size)
    transcriptReaderCensus.bytesRead += buf.length
    if (buf.length === 0) return null
    if (buf[buf.length - 1] === NEWLINE) return null
    const nl = buf.lastIndexOf(NEWLINE)
    if (nl !== -1) return Buffer.from(buf.subarray(nl + 1))
    if (len >= size) return Buffer.from(buf)
    if (len >= FRAGMENT_SCAN_MAX) return null
  }
}

/**
 * The cold ladder, fastest first:
 *   1. snapshot + tail — deserialize the persisted fold, decode only the
 *      bytes appended since; any invalidation falls through;
 *   2. big files: fd-level pre-boundary truncation + a byte scan that
 *      recovers pre-boundary session metadata, then (when no preserved
 *      segment forbids it) dead-branch pruning before the JSON parse;
 *   3. plain full read.
 * The state it hands back covers a complete-line boundary: an unterminated
 * final line the decoder classified stays outside the offset so the growth
 * read that completes it folds the whole record.
 */
async function coldRead(path: string, policy: TranscriptReadPolicy): Promise<{ state: ReaderState; read: TranscriptRead }> {
  transcriptReaderCensus.coldReads++
  const state: ReaderState = {
    path,
    policy,
    generation: ++generationSeq,
    offset: 0,
    size: 0,
    ino: 0,
    window: EMPTY,
    tornCounted: false,
    fold: emptyFoldState(),
    pruned: false,
    refusal: null,
    bytesSinceSnapshot: 0,
    degradedSinceSnapshot: false,
    chain: null,
  }
  const absent: TranscriptRead = { kind: 'none', accounting: ZERO_ACCOUNTING, refusal: null }
  const st = io.statSync(path)
  // Missing file = a session that has not written yet: quiet, empty.
  if (st === null) return { state, read: absent }
  state.ino = st.ino
  state.size = st.size

  let accounting: TranscriptReadAccounting = ZERO_ACCOUNTING
  let consumed = 0
  let fragment: Buffer | null = null
  let plainBuf: Buffer | null = null
  let snapshotCovered = false
  let wroteSnapshot = false

  if (policy === 'resume') {
    const hit = await tryLoadResumeSnapshot(path)
    if (hit) {
      const decodedTail = decodeTranscriptBuffer<Entry>(hit.tail)
      if (decodedTail.refusal) {
        // The tail's FIRST line is not a record line, so the decoder
        // refused the whole tail — but the tail is a mid-file slice, and
        // record lines past that first line are still the user's history
        // (the plain road classifies per line and folds them). Say so and
        // fall through; the snapshot cursor never advances over it.
        logError(new Error(`${decodedTail.refusal}: ${path} (snapshot tail — reloading the file whole)`))
      } else {
        state.fold = hit.fold
        const degraded = decodedTail.malformed.length > 0 || decodedTail.invalid.length > 0
        if (degraded) {
          logError(
            new Error(
              `transcript tail degraded on snapshot resume: ${decodedTail.malformed.length} malformed, ${decodedTail.invalid.length} invalid of ${decodedTail.totalLines}`,
            ),
          )
          noteLoadDegradation({ path, malformed: decodedTail.malformed.length, invalid: decodedTail.invalid.length, totalLines: decodedTail.totalLines, refusal: null })
        }
        for (const entry of decodedTail.entries) applyTranscriptEntry(state.fold, entry)
        accounting = { malformed: decodedTail.malformed.length, invalid: decodedTail.invalid.length, totalLines: decodedTail.totalLines }
        snapshotCovered = true
        consumed = hit.fileSize
        transcriptReaderCensus.bytesRead += hit.tail.length
        const nl = hit.tail.lastIndexOf(NEWLINE)
        fragment = nl === hit.tail.length - 1 ? null : Buffer.from(hit.tail.subarray(nl + 1))
        state.degradedSinceSnapshot = degraded
        state.bytesSinceSnapshot = hit.tail.length
        // A materially grown tail earns a refreshed snapshot behind the
        // load — only when the tail folded CLEAN: a cursor published over
        // degraded lines would bake their loss into every later resume.
        if (!degraded && hit.tail.length > SNAPSHOT_REFRESH_BYTES) {
          writeResumeSnapshot(path, state.fold, hit.fileSize)
          wroteSnapshot = true
        }
      }
    }
  }

  if (!snapshotCovered) {
    // Large sessions must not materialize their stale majority: the
    // chunked fd read skips attribution-snapshot lines before they reach a
    // buffer and truncates at the last compact boundary in-stream, so peak
    // allocation tracks the OUTPUT, not the file.
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (st.size > SKIP_PRECOMPACT_THRESHOLD) {
      const scan = await readTranscriptForLoad(path, st.size)
      buf = scan.postBoundaryBuf
      hasPreservedSegment = scan.hasPreservedSegment
      transcriptReaderCensus.bytesRead += st.size
      // boundaryStartOffset > 0 means bytes were truncated away and the
      // session-scoped metadata that lived there (mode, pr-link, agent-*)
      // must be recovered by the cheap byte scan.
      if (scan.boundaryStartOffset > 0) {
        metadataLines = await scanPreBoundaryMetadata(path, scan.boundaryStartOffset)
      }
      consumed = st.size
      fragment = fileFragment(path, st.size)
    }
    if (buf === null) {
      buf = await readFile(path)
      plainBuf = buf
      transcriptReaderCensus.bytesRead += buf.length
      consumed = buf.length
      const nl = buf.lastIndexOf(NEWLINE)
      fragment = buf.length === 0 || nl === buf.length - 1 ? null : buf.subarray(nl + 1)
    }
    // Dead-branch pruning earns its keep only on big buffers. Skipped when
    // the caller wants every leaf (a listing picks branches by message
    // count, not recency) and when a preserved segment exists — preserved
    // lines carry pre-compact parentUuids on disk and only the post-parse
    // relink makes them reachable, so a pre-parse walk would prune them.
    if (policy === 'resume' && !hasPreservedSegment && buf.length > SKIP_PRECOMPACT_THRESHOLD) {
      const before = buf
      buf = pruneRecordBranchesBeforeParse(buf)
      state.pruned = buf !== before
    }
    // Recovered pre-boundary metadata folds first; the post-boundary
    // buffer may re-state some of it, and later values winning is the
    // correct outcome for session-scoped maps.
    if (metadataLines && metadataLines.length > 0) {
      const metaEntries = parseJSONL<Entry>(Buffer.from(metadataLines.join('\n')))
      for (const entry of metaEntries) {
        // Metadata kinds ONLY: the byte scanner can false-positive on a
        // marker string INSIDE message content — such a line must stay
        // inert here; a pre-boundary message resurrecting through the
        // metadata pass would corrupt the chain.
        if (PRE_BOUNDARY_METADATA_KINDS.has(entry.type)) applyTranscriptEntry(state.fold, entry)
      }
    }
    // The validating read seam: every line is accounted for — malformed and
    // shape-invalid records are CLASSIFIED and the fold proceeds on the
    // valid set. A file that is not in the record format is refused whole:
    // one honest line, an empty fold, never a crash.
    const decoded = decodeTranscriptBuffer<Entry>(buf)
    if (decoded.refusal) {
      logError(new Error(`${decoded.refusal}: ${path}`))
      // The refusal is STATED in-session: the session is about to resume
      // EMPTY of its prior records, and silence here was the defect.
      noteLoadDegradation({ path, malformed: 0, invalid: 0, totalLines: decoded.totalLines, refusal: decoded.refusal })
      state.refusal = decoded.refusal
      state.fold = emptyFoldState()
      accounting = { malformed: 0, invalid: 0, totalLines: decoded.totalLines }
    } else {
      if (decoded.malformed.length > 0 || decoded.invalid.length > 0) {
        logError(
          new Error(
            `transcript degraded on load: ${decoded.malformed.length} malformed line(s), ` +
              `${decoded.invalid.length} invalid-shape record(s) of ${decoded.totalLines} ` +
              `(first: ${decoded.malformed[0] ? `line ${decoded.malformed[0].line}` : `#${decoded.invalid[0]?.index} ${decoded.invalid[0]?.reason}`})`,
          ),
        )
        noteLoadDegradation({ path, malformed: decoded.malformed.length, invalid: decoded.invalid.length, totalLines: decoded.totalLines, refusal: null })
        state.degradedSinceSnapshot = true
      }
      for (const entry of decoded.entries) applyTranscriptEntry(state.fold, entry)
      accounting = { malformed: decoded.malformed.length, invalid: decoded.invalid.length, totalLines: decoded.totalLines }
    }
  }

  // The consumed boundary: an unterminated final line the decoder saw is
  // either a whole record without its newline (folded — consumed) or a
  // torn append (classified malformed — left outside the offset so its
  // completion folds whole, and not counted twice).
  let offset = consumed
  if (fragment !== null && fragment.length > 0 && !isCompleteJsonLine(fragment)) {
    offset = consumed - fragment.length
    state.tornCounted = state.refusal === null
  }
  state.offset = offset
  if (offset > 0) {
    const from = Math.max(0, offset - WINDOW_BYTES)
    if (plainBuf !== null) {
      state.window = Buffer.from(plainBuf.subarray(from, offset))
    } else {
      state.window = io.readRangeSync(path, from, offset)
      transcriptReaderCensus.bytesRead += state.window.length
    }
  }

  if (state.refusal === null) {
    applyPreservedSegmentRelinks(state.fold.messages)
    applySnipRemovals(state.fold.messages)
    // Write-behind: pay the serialization now so the NEXT process resumes
    // O(tail). The cursor is the folded boundary — an append racing this
    // read lands past it and folds in as tail.
    if (!snapshotCovered && policy === 'resume' && resumeSnapshotEnabled() && offset >= SNAPSHOT_MIN_BYTES) {
      writeResumeSnapshot(path, state.fold, offset)
      wroteSnapshot = true
    }
  }
  if (wroteSnapshot) state.bytesSinceSnapshot = 0
  else if (!snapshotCovered) state.bytesSinceSnapshot = offset

  return { state, read: { kind: 'cold', accounting, refusal: state.refusal } }
}

// ── the conversation chain since a cursor ───────────────────────────────────

/** The chain rows minted per source message, so an unchanged record keeps
 *  its row object across derivations (the calm law's identity link). */
const rowOfSource = new WeakMap<TranscriptMessage, SerializedMessage>()
const rowTokens = new WeakMap<object, string>()
let rowSeq = 0

function rowFor(source: TranscriptMessage): SerializedMessage {
  let row = rowOfSource.get(source)
  if (row === undefined) {
    row = removeExtraFields([source])[0]!
    rowOfSource.set(source, row)
    rowTokens.set(row, `row:${++rowSeq}`)
  }
  return row
}

/** The chain rows' content signature for the connector's merge, resolved
 *  once per merge: a row the reader minted carries its identity token (the
 *  reader mints a new row only for a new or revised record — the token IS
 *  the content key); any other row signs by its serialization. With the
 *  reader off every read re-mints, so serialization is the signature. */
export function chainRowSigner(): (row: unknown) => string {
  if (!transcriptReaderEnabled()) return row => JSON.stringify(row)
  return row => {
    const token = typeof row === 'object' && row !== null ? rowTokens.get(row) : undefined
    return token ?? JSON.stringify(row)
  }
}

function deriveChainRows(fold: TranscriptFoldState, prev: readonly SerializedMessage[] | undefined): readonly SerializedMessage[] {
  transcriptReaderCensus.chainDerivations++
  const messages = fold.messages
  const leaves = computeResumeLeaves(messages)
  const leaf = findLatestMessage(messages.values(), m => leaves.has(m.uuid) && (m.type === 'user' || m.type === 'assistant'))
  const rows = leaf ? buildConversationChain(messages, leaf).map(rowFor) : []
  if (prev !== undefined && prev.length === rows.length && rows.every((r, i) => r === prev[i])) return prev
  return rows
}

export interface TranscriptChainCursor {
  generation: number
  rows: readonly SerializedMessage[]
}

export interface TranscriptChainSince {
  /** The conversation chain from the newest resume leaf, envelope fields
   *  stripped — the rows the resume road hands the chat. The ARRAY keeps
   *  its identity while nothing moved; a row keeps its object identity
   *  while its record stands unchanged. */
  rows: readonly SerializedMessage[]
  /** The first index whose row differs from the cursor's view: rows before
   *  it are the cursor's own objects. */
  since: number
  /** rows.slice(since). */
  appended: readonly SerializedMessage[]
  /** Rows the cursor held changed or vanished (a revision, a rewind, a
   *  reset) — the consumer refolds from `since`, never only appends. */
  rewound: boolean
  cursor: TranscriptChainCursor
  view: TranscriptView
}

/**
 * The conversation chain of a transcript since the caller's cursor — the
 * focused chat's read. Growth costs the appended bytes plus one chain walk
 * over the fold (pointer work, no parse); an unchanged file costs a stat.
 */
export async function readTranscriptChainSince(
  path: string,
  cursor: TranscriptChainCursor | null,
  opts?: { policy?: TranscriptReadPolicy },
): Promise<TranscriptChainSince> {
  const view = await readTranscript(path, opts)
  const state = states.get(path)
  let rows: readonly SerializedMessage[]
  if (state !== undefined && state.generation === view.generation) {
    const memo = state.chain
    if (memo !== null && memo.offset === state.offset) rows = memo.rows
    else {
      rows = deriveChainRows(state.fold, memo?.rows ?? cursor?.rows)
      state.chain = { generation: state.generation, offset: state.offset, rows }
    }
  } else {
    rows = deriveChainRows(view.fold, cursor?.rows)
  }
  let since = 0
  if (cursor !== null && cursor.generation === view.generation) {
    const n = Math.min(cursor.rows.length, rows.length)
    while (since < n && cursor.rows[since] === rows[since]) since++
  }
  const rewound = cursor !== null && since < cursor.rows.length
  return {
    rows,
    since,
    appended: since === 0 ? rows : rows.slice(since),
    rewound,
    cursor: { generation: view.generation, rows },
    view,
  }
}

// ── the byte cursor: complete lines past an offset, and lines backward ─────

export interface TranscriptByteCursor {
  /** Byte offset of the first unread byte. */
  offset: number
  /** The torn tail carried from the last read (never parsed, never lost). */
  carry: string
}

export interface TranscriptBytesAfter {
  /** The complete lines past the cursor (no trailing newline; empty when
   *  nothing complete landed). */
  text: string
  cursor: TranscriptByteCursor
  /** The file SHRANK under the cursor (a replaced transcript): the read
   *  started over from zero and the consumer repaints from scratch. */
  rewound: boolean
  size: number
}

/**
 * The complete lines appended past a caller-held byte cursor — the read
 * behind every line-folding consumer (the concourse mirror, the close
 * receipt). Reads only the suffix bytes; a missing file answers empty at
 * offset 0 (the writer may not have written yet — honest, not an error);
 * an unterminated last line is carried, never parsed, never dropped.
 */
export function readTranscriptBytesAfter(path: string, cursor: TranscriptByteCursor): TranscriptBytesAfter {
  const st = io.statSync(path)
  if (st === null) return { text: '', cursor: { offset: 0, carry: '' }, rewound: cursor.offset > 0, size: 0 }
  let from = cursor.offset
  let carry = cursor.carry
  let rewound = false
  if (st.size < cursor.offset) {
    from = 0
    carry = ''
    rewound = true
  }
  if (st.size === from) return { text: '', cursor: { offset: from, carry }, rewound, size: st.size }
  const buf = io.readRangeSync(path, from, st.size)
  transcriptReaderCensus.bytesRead += buf.length
  const combined = carry + buf.toString('utf8')
  const lastNewline = combined.lastIndexOf('\n')
  return {
    text: lastNewline === -1 ? '' : combined.slice(0, lastNewline),
    cursor: { offset: from + buf.length, carry: lastNewline === -1 ? combined : combined.slice(lastNewline + 1) },
    rewound,
    size: st.size,
  }
}

/**
 * Visit a transcript's lines newest first, reading the tail in widening
 * windows (64 KB, then ×4) so a walk that stops early never reads the whole
 * file. A visitor returning true stops the walk. A window's leading partial
 * line is skipped (its head is outside the window) unless the window is the
 * whole file; an unterminated final line is visited as it stands.
 */
export function scanTranscriptLinesBackward(path: string, visit: (line: string) => boolean | void): void {
  const st = io.statSync(path)
  if (st === null || st.size === 0) return
  const size = st.size
  let visitedFrom = size
  for (let len = Math.min(size, BACKWARD_WINDOW_BYTES); ; len = Math.min(size, len * 4)) {
    const from = size - len
    const buf = io.readRangeSync(path, from, size)
    transcriptReaderCensus.bytesRead += buf.length
    if (buf.length < len) return
    const region = buf.subarray(0, visitedFrom - from)
    // The region ends at a line start, so its last piece is the empty
    // remainder after that newline (or the file's unterminated tail on the
    // first pass); a leading partial piece belongs to a line whose head sits
    // before the window and is skipped — its byte length (not its decoded
    // length: the cut may fall inside a multi-byte character) says where
    // the visited lines begin.
    const firstNl = from > 0 ? region.indexOf(NEWLINE) : -1
    const whole = from > 0 ? (firstNl === -1 ? EMPTY : region.subarray(firstNl + 1)) : region
    const pieces = whole.toString('utf8').split('\n')
    for (let i = pieces.length - 1; i >= 0; i--) {
      const line = pieces[i]!
      if (line.length === 0) continue
      if (visit(line) === true) return
    }
    visitedFrom = from > 0 && firstNl !== -1 ? from + firstNl + 1 : visitedFrom
    if (from === 0) return
  }
}

// ── resume leaves ───────────────────────────────────────────────────────────

/**
 * Resume anchors, computed once per fold. Only user/assistant messages may
 * anchor a resume — system/attachment entries are bookkeeping — so from
 * every terminal message (no children) the walk backs up to the nearest
 * user/assistant ancestor.
 *
 * Behind the pebble-prune gate, an ancestor that already has a
 * user/assistant CHILD is skipped: the conversation demonstrably continued
 * through it (e.g. a tool_use assistant whose progress child is terminal
 * but whose tool_result child carries on), so it is a mid-chain node, not
 * a leaf.
 */
export function computeResumeLeaves(messages: Map<UUID, TranscriptMessage>): Set<UUID> {
  const allMessages = [...messages.values()]

  const parentUuids = new Set(
    allMessages.map(msg => msg.parentUuid).filter((uuid): uuid is UUID => uuid !== null),
  )
  const terminalMessages = allMessages.filter(msg => !parentUuids.has(msg.uuid))

  const pruneMidConversation = getFeatureValue_CACHED_MAY_BE_STALE('mercury_pebble_leaf_prune', false)
  const hasUserAssistantChild = new Set<UUID>()
  if (pruneMidConversation) {
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === 'user' || msg.type === 'assistant')) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }
  }

  const leafUuids = new Set<UUID>()
  let hasCycle = false
  for (const terminal of terminalMessages) {
    const seen = new Set<UUID>()
    let current: TranscriptMessage | undefined = terminal
    while (current) {
      if (seen.has(current.uuid)) {
        hasCycle = true
        break
      }
      seen.add(current.uuid)
      if (current.type === 'user' || current.type === 'assistant') {
        if (!pruneMidConversation || !hasUserAssistantChild.has(current.uuid)) {
          leafUuids.add(current.uuid)
        }
        break
      }
      current = current.parentUuid ? messages.get(current.parentUuid) : undefined
    }
  }

  if (hasCycle) {
    // The walk guarded itself; say so once — a cyclic chain means a writer
    // bug upstream and silent tolerance would bury it.
    logForDebugging('cycle detected during resume-leaf computation', { level: 'warn' })
  }

  return leafUuids
}

/** TEST-ONLY: drop every state and zero the census. */
export function _resetTranscriptReaderForTesting(): void {
  states.clear()
  retained.clear()
  recent.length = 0
  inflight.clear()
  transcriptReaderCensus.coldReads = 0
  transcriptReaderCensus.growthReads = 0
  transcriptReaderCensus.resets = 0
  transcriptReaderCensus.bytesRead = 0
  transcriptReaderCensus.chainDerivations = 0
}

/** TEST-ONLY: the retained paths and the recent list (the retention proof). */
export function _transcriptReaderRetentionForTesting(): { states: string[]; retained: string[]; recent: string[] } {
  return { states: [...states.keys()], retained: [...retained.keys()], recent: [...recent] }
}

// ── the pre-boundary metadata scan (big files) ──────────────────────────────

// Carry-resolution for the metadata scanner: null carry = the previous
// chunk ended mid-line inside content we already know is not metadata.
// A short carry might still grow into the record-envelope prefix, so it
// concatenates; a long carry concatenates only when it opens with the
// envelope key (metaKind sits deeper in the line).
function resolveMetadataBuf(carry: Buffer | null, chunkBuf: Buffer): Buffer | null {
  if (carry === null || carry.length === 0) return chunkBuf
  if (carry.length < METADATA_PREFIX_BOUND) {
    return Buffer.concat([carry, chunkBuf])
  }
  if (
    carry.compare(
      RECORD_CARRY_PREFIX,
      0,
      RECORD_CARRY_PREFIX.length,
      0,
      Math.min(carry.length, RECORD_CARRY_PREFIX.length),
    ) === 0
  ) {
    return Buffer.concat([carry, chunkBuf])
  }
  const firstNl = chunkBuf.indexOf(NEWLINE)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

/**
 * Byte-level forward scan of [0, endOffset) that collects ONLY
 * metadata-entry lines. No readline, no string decode for the ~99% of
 * bytes that are message content: a chunk containing zero marker bytes is
 * skipped whole, and line splitting happens only around actual matches.
 */
async function scanPreBoundaryMetadata(filePath: string, endOffset: number): Promise<string[]> {
  const { createReadStream } = await import('fs')

  const stream = createReadStream(filePath, { end: endOffset - 1 })
  const metadataLines: string[] = []
  let carry: Buffer | null = null

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = resolveMetadataBuf(carry, chunkBuf)
    if (buf === null) {
      carry = null
      continue
    }

    let hasAnyMarker = false
    for (const m of METADATA_MARKER_BUFS) {
      if (buf.includes(m)) {
        hasAnyMarker = true
        break
      }
    }

    if (hasAnyMarker) {
      let lineStart = 0
      let nl = buf.indexOf(NEWLINE)
      while (nl !== -1) {
        // Marker check bounded to this line's bytes.
        for (const m of METADATA_MARKER_BUFS) {
          const mIdx = buf.indexOf(m, lineStart)
          if (mIdx !== -1 && mIdx < nl) {
            metadataLines.push(buf.toString('utf-8', lineStart, nl))
            break
          }
        }
        lineStart = nl + 1
        nl = buf.indexOf(NEWLINE, lineStart)
      }
      carry = buf.subarray(lineStart)
    } else {
      // Nothing here — keep only the unterminated trailing line.
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    // A newline-free multi-MB tool-output line would otherwise grow the
    // carry quadratically. Real metadata entries stay under 1 KB, so a
    // 64 KB carry is provably mid-content — drop it.
    if (carry.length > 64 * 1024) carry = null
  }

  // The final line may end at endOffset without a newline.
  if (carry !== null && carry.length > 0) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.includes(m)) {
        metadataLines.push(carry.toString('utf-8'))
        break
      }
    }
  }

  return metadataLines
}

// ── dead-branch pruning (byte level, before any full parse) ─────────────────

// Every record line opens with the envelope's first two keys in compact
// serialization; recordId (== the entry uuid, the identity law) sits at a
// FIXED offset. A raw double-quote cannot occur inside a JSON string value,
// and content newlines serialize escaped, so this prefix at line start is
// structural — content can never forge it.
const RECORD_LINE_PREFIX = Buffer.from('{"schemaVersion":1,"recordId":"')
const PRUNE_KIND_NEEDLE = Buffer.from('"payload":{"kind":"')
/** The envelope's payload key sits after the fixed-shape envelope fields;
 *  a record EMBEDDED inside another record's fields sits past its host's
 *  envelope, beyond this bound. */
const PRUNE_KIND_BOUND = 600
/** Payload kinds whose lines are parentUuid-chain nodes; every other
 *  record kind (session-meta, tool-settlement, receipt, unknown-retained)
 *  is session metadata the fold needs whole. */
const PRUNE_CHAIN_KINDS = new Set(['input', 'output', 'attachment', 'notice', 'boundary', 'progress'])

/**
 * Prune dead fork branches at the byte level, before any full parse.
 *
 * Every rewind/fork strands a branch in the append-only file forever; the
 * fold discards them AFTER parse — by which point the parse has paid for
 * every dead byte. This walk indexes record lines by their FIXED-offset
 * recordId, picks the last non-sidechain conversation row as the live
 * leaf, and walks leaf→root. LINK TRUTH COMES FROM THE PARSED LINE: each
 * hop decodes exactly one line through the real read seam (validate +
 * project) and follows the ENTRY's own parentUuid — byte heuristics only
 * ever choose which single lines to decode, so content that echoes record
 * spellings (a tool result quoting a transcript) can never misroute the
 * walk. Cost: O(live chain) line decodes + native byte scans.
 *
 * Kept: every non-record and metadata-kind line, plus every line of a
 * live-chain recordId (a settled pair keeps both lines). Dropped: chain-
 * node lines no live-leaf walk reaches. Stitching only pays when at least
 * half the buffer is dead chain bytes; anything unexpected (foreign lines,
 * an unparsable leaf, no leaf at all) returns the buffer unchanged.
 */
export function pruneRecordBranchesBeforeParse(buf: Buffer): Buffer {
  const QUOTE = 0x22
  const PREFIX_LEN = RECORD_LINE_PREFIX.length

  // Flat stride-2 line index [start, end) for chain-node lines; keepRanges
  // for everything else (metadata kinds, non-record lines). idToSlots maps
  // recordId → every slot holding a line of that id (settled pairs).
  const nodeIdx: number[] = []
  const nodeIds: string[] = []
  const keepRanges: number[] = []
  const idToSlots = new Map<string, number[]>()
  let chainBytes = 0

  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    let isChainNode = false
    if (
      lineEnd - pos > PREFIX_LEN + 2 &&
      buf.compare(RECORD_LINE_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      const idStart = pos + PREFIX_LEN
      const idEnd = buf.indexOf(QUOTE, idStart)
      const kindAt = buf.indexOf(PRUNE_KIND_NEEDLE, pos)
      if (
        idEnd > idStart &&
        idEnd - idStart <= 64 &&
        kindAt !== -1 &&
        kindAt < pos + PRUNE_KIND_BOUND &&
        kindAt < lineEnd
      ) {
        const kindStart = kindAt + PRUNE_KIND_NEEDLE.length
        const kindEnd = buf.indexOf(QUOTE, kindStart)
        if (kindEnd > kindStart && PRUNE_CHAIN_KINDS.has(buf.toString('latin1', kindStart, kindEnd))) {
          const id = buf.toString('latin1', idStart, idEnd)
          const slot = nodeIds.length
          nodeIdx.push(pos, lineEnd)
          nodeIds.push(id)
          const slots = idToSlots.get(id)
          if (slots) slots.push(slot)
          else idToSlots.set(id, [slot])
          chainBytes += lineEnd - pos
          isChainNode = true
        }
      }
    }
    if (!isChainNode) keepRanges.push(pos, lineEnd)
    pos = lineEnd
  }
  if (nodeIds.length === 0) return buf

  // One line through the REAL read seam: validated record → projected entry.
  const decodeSlot = (slot: number): Record<string, unknown> | null => {
    const d = decodeTranscriptBuffer<Record<string, unknown>>(
      buf.subarray(nodeIdx[slot * 2]!, nodeIdx[slot * 2 + 1]!),
    )
    return d.entries.length === 1 ? d.entries[0]! : null
  }

  // The live leaf: the LAST chain node that decodes to a non-sidechain
  // entry. Every candidate is parse-confirmed — no byte heuristic may pick
  // the leaf, because a skipped legitimate leaf would prune the real tail.
  let leaf: Record<string, unknown> | null = null
  for (let slot = nodeIds.length - 1; slot >= 0; slot--) {
    const e = decodeSlot(slot)
    if (e === null || e.isSidechain === true) continue
    leaf = e
    break
  }
  if (leaf === null) return buf

  // Walk leaf→root along the PARSED entries' parentUuid. A parent absent
  // from the index terminates the walk — normal for post-boundary chains.
  const liveIds = new Set<string>()
  let liveBytes = 0
  let cur: Record<string, unknown> | null = leaf
  while (cur) {
    const id = typeof cur.uuid === 'string' ? cur.uuid : null
    if (id === null || liveIds.has(id)) break
    liveIds.add(id)
    for (const slot of idToSlots.get(id) ?? []) {
      liveBytes += nodeIdx[slot * 2 + 1]! - nodeIdx[slot * 2]!
    }
    const parent = typeof cur.parentUuid === 'string' && cur.parentUuid ? cur.parentUuid : null
    if (parent === null) break
    const slots = idToSlots.get(parent)
    if (!slots || slots.length === 0) break
    // The LAST published line of the parent id carries its settled state.
    cur = decodeSlot(slots[slots.length - 1]!)
  }
  if (liveIds.size === 0) return buf

  // Stitch only when at least half the buffer is dead chain bytes — near
  // break-even the concat memcpy dominates the parse savings.
  const deadBytes = chainBytes - liveBytes
  if (deadBytes < len >> 1) return buf

  // Interleave kept metadata lines with live chain lines in file order —
  // both indexes are already offset-sorted — and concat once.
  const parts: Buffer[] = []
  let k = 0
  for (let slot = 0; slot < nodeIds.length; slot++) {
    const start = nodeIdx[slot * 2]!
    while (k < keepRanges.length && keepRanges[k]! < start) {
      parts.push(buf.subarray(keepRanges[k]!, keepRanges[k + 1]!))
      k += 2
    }
    if (liveIds.has(nodeIds[slot]!)) {
      parts.push(buf.subarray(start, nodeIdx[slot * 2 + 1]!))
    }
  }
  while (k < keepRanges.length) {
    parts.push(buf.subarray(keepRanges[k]!, keepRanges[k + 1]!))
    k += 2
  }
  return Buffer.concat(parts)
}

/**
 * Session-scoped entry kinds that must survive a pre-boundary truncation.
 * Held as raw JSON marker strings so the scanner filters lines by bytes:
 * the entry kind travels as `metaKind` on the session-meta record, and
 * collected lines re-decode through the projecting read seam.
 */
const METADATA_TYPE_MARKERS = [
  '"metaKind":"summary"',
  '"metaKind":"custom-title"',
  '"metaKind":"tag"',
  '"metaKind":"agent-name"',
  '"metaKind":"agent-color"',
  '"metaKind":"agent-setting"',
  '"metaKind":"mode"',
  '"metaKind":"worktree-state"',
  '"metaKind":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map(m => Buffer.from(m))
/** Record lines open with the envelope's first key. */
const RECORD_CARRY_PREFIX = Buffer.from('{"schemaVersion":')
/** The kinds the pre-boundary metadata pass may fold — record lines
 *  re-decode through the read seam before this is consulted. */
const PRE_BOUNDARY_METADATA_KINDS = new Set(
  METADATA_TYPE_MARKERS.map(m => /"metaKind":"([^"]+)"/.exec(m)![1]!),
)
// A carry shorter than this cannot yet rule out the record-envelope prefix.
const METADATA_PREFIX_BOUND = 25
