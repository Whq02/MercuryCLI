// ============================================================================
//  changeTransaction/seenLines — the per-line read-evidence ledger.
//
//  The read-before-edit law, sharpened from "the file was read" to "the
//  exact LINES this edit touches were actually SHOWN to the model". Reads
//  (full and windowed) and content-mode search hits record shown ranges; a
//  patch-dialect edit addressing lines that were never displayed refuses
//  with the smallest re-read hint. After a patch commits, the rewritten
//  regions count as seen (the model authored them) and untouched seen
//  ranges are shifted through the applied spans — fresh-anchor chaining
//  works WITHOUT a re-read.
//
//  Generations: an entry is valid only for the file state it was recorded
//  against — keyed `m<floor(mtimeMs)>:<byteLength>`. Cheap to compute at
//  every seam (one stat), and honest: content correctness stays with the
//  ANCHOR check; the ledger only answers "was this line displayed for the
//  content the anchor already proved current".
//
//  Bounds: ranges per file are coalesced; at the cap the OLDEST ranges are
//  dropped (forgetting refuses more re-reads — it never claims unseen lines
//  seen). Owner-scoped, conversation-lifetime.
// ============================================================================

import { statSync } from 'node:fs'
import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import type { HunkSpan } from './hunks.js'

export const SEEN_LINES_BOUNDS = {
  /** Coalesced ranges per file (oldest drop first). */
  rangeCap: 256,
  /** Files per owner (LRU). */
  fileCap: 512,
} as const

/** Inclusive 1-based line range. */
export type SeenRange = { start: number; end: number }

interface FileLedger {
  generation: string
  /** Coalesced, kept sorted by start. Insertion recency tracked separately
   *  for the bounded-forget order. */
  ranges: SeenRange[]
}

interface LedgerState {
  files: Map<string, FileLedger>
}

const store = new OwnerScopedStore<LedgerState>({
  name: 'seen-lines',
  create: () => ({ files: new Map() }),
  cap: 32,
})
registerOwnerScopedStore(store)

/** The generation key for a file's CURRENT on-disk state. */
export function fileGeneration(path: string): string | null {
  try {
    const st = statSync(path)
    return `m${Math.floor(st.mtimeMs)}:${st.size}`
  } catch {
    return null
  }
}

function coalesce(ranges: SeenRange[]): SeenRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: SeenRange[] = [sorted[0]!]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!
    const last = out[out.length - 1]!
    if (cur.start <= last.end + 1) {
      if (cur.end > last.end) last.end = cur.end
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

function ledgerFor(owner: OwnerKey, path: string): Map<string, FileLedger> {
  const state = store.get(owner)
  return state.files
}

/**
 * Record shown lines for a file at a generation. A different generation
 * RESETS the entry (older sightings addressed different bytes).
 */
export function recordSeenLines(
  owner: OwnerKey,
  path: string,
  generation: string,
  startLine: number,
  lineCount: number,
): void {
  if (lineCount <= 0 || startLine < 1) return
  const files = ledgerFor(owner, path)
  let entry = files.get(path)
  if (!entry || entry.generation !== generation) {
    entry = { generation, ranges: [] }
  } else {
    files.delete(path) // re-set on touch: LRU recency
  }
  entry.ranges.push({ start: startLine, end: startLine + lineCount - 1 })
  entry.ranges = coalesce(entry.ranges)
  while (entry.ranges.length > SEEN_LINES_BOUNDS.rangeCap) {
    // Forget the SMALLEST range first — least evidence lost per slot freed,
    // and forgetting only ever forces a re-read, never fabricates sight.
    let smallest = 0
    for (let i = 1; i < entry.ranges.length; i++) {
      const a = entry.ranges[i]!
      const b = entry.ranges[smallest]!
      if (a.end - a.start < b.end - b.start) smallest = i
    }
    entry.ranges.splice(smallest, 1)
  }
  files.set(path, entry)
  while (files.size > SEEN_LINES_BOUNDS.fileCap) {
    const oldest = files.keys().next().value as string | undefined
    if (oldest === undefined) break
    files.delete(oldest)
  }
}

export type SeenLinesVerdict =
  | { ok: true }
  | {
      ok: false
      /** The touched lines that were never shown (bounded to 8 ranges). */
      unseen: SeenRange[]
      hint: string
    }

/** The lines one hunk span TOUCHES (an insert touches its anchor line). */
function touchedRange(span: HunkSpan): SeenRange {
  return { start: span.start, end: span.end }
}

/**
 * Check that every line a set of spans touches was SHOWN at the given
 * generation. Missing entry / generation mismatch counts every touched line
 * unseen (the honest default — the ledger never guesses).
 */
export function checkSeenLines(
  owner: OwnerKey,
  path: string,
  generation: string,
  spans: readonly HunkSpan[],
  displayPath?: string,
): SeenLinesVerdict {
  const entry = store.peek(owner)?.files.get(path)
  const ranges = entry && entry.generation === generation ? entry.ranges : []
  const unseen: SeenRange[] = []
  for (const span of spans) {
    const t = touchedRange(span)
    let cursor = t.start
    for (const r of ranges) {
      if (r.end < cursor) continue
      if (r.start > t.end) break
      if (r.start > cursor) unseen.push({ start: cursor, end: Math.min(r.start - 1, t.end) })
      cursor = Math.max(cursor, r.end + 1)
      if (cursor > t.end) break
    }
    if (cursor <= t.end) unseen.push({ start: cursor, end: t.end })
  }
  if (unseen.length === 0) return { ok: true }
  const merged = coalesce(unseen).slice(0, 8)
  const display = displayPath ?? path
  const spellRange = (r: SeenRange): string => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)
  const first = merged[0]!
  return {
    ok: false,
    unseen: merged,
    hint:
      `lines ${merged.map(spellRange).join(', ')} of ${display} were never displayed this session — ` +
      `Read(offset: ${first.start}, limit: ${first.end - first.start + 1}) the smallest missing range (and the others if needed), then re-apply`,
  }
}

/**
 * Post-commit shift: map the seen set THROUGH the applied spans so chaining
 * needs no re-read. Replaced/inserted regions become seen (the model
 * authored them); untouched ranges shift by the running line delta.
 */
export function shiftSeenLinesAfterApply(
  owner: OwnerKey,
  path: string,
  newGeneration: string,
  spans: readonly HunkSpan[],
  replacementLineCount: (span: HunkSpan) => number,
): void {
  const files = ledgerFor(owner, path)
  const entry = files.get(path)
  const oldRanges = entry?.ranges ?? []
  const events = [...spans].sort((a, b) => a.start - b.start)
  const newRanges: SeenRange[] = []

  // Walk old seen ranges through the splice events.
  for (const r of oldRanges) {
    let delta = 0
    let start = r.start
    let end = r.end
    let dropped = false
    for (const s of events) {
      const repLines = replacementLineCount(s)
      if (s.insert === 'before' || s.insert === 'after') {
        const at = s.insert === 'before' ? s.start : s.end + 1
        if (at <= start) delta += repLines
        else if (at <= end) end += repLines // insertion splits a seen range; the tail shifts
        continue
      }
      const removed = s.end - s.start + 1
      const shift = repLines - removed
      if (s.end < start) {
        delta += shift
        continue
      }
      if (s.start > end) continue
      // Overlap: the replaced part of the seen range is no longer "the same
      // lines" — trim the seen range to its untouched prefix/suffix.
      if (s.start <= start && s.end >= end) {
        dropped = true
        break
      }
      if (s.start > start && s.end < end) {
        // Replacement strictly inside: keep prefix, tail handled by shift.
        end = end + shift
        continue
      }
      if (s.start <= start) {
        start = s.end + 1 + shift
        delta += shift
        continue
      }
      end = s.start - 1
    }
    if (!dropped && end >= start) newRanges.push({ start: start + delta, end: end + delta })
  }

  // The spans' OWN output regions are seen (the model authored them).
  let running = 0
  for (const s of events) {
    const repLines = replacementLineCount(s)
    if (s.insert === 'before') {
      if (repLines > 0) newRanges.push({ start: s.start + running, end: s.start + running + repLines - 1 })
      running += repLines
      continue
    }
    if (s.insert === 'after') {
      if (repLines > 0) newRanges.push({ start: s.end + 1 + running, end: s.end + running + repLines })
      running += repLines
      continue
    }
    const removed = s.end - s.start + 1
    if (repLines > 0) newRanges.push({ start: s.start + running, end: s.start + running + repLines - 1 })
    running += repLines - removed
  }

  files.delete(path)
  files.set(path, { generation: newGeneration, ranges: coalesce(newRanges).slice(0, SEEN_LINES_BOUNDS.rangeCap) })
}

/** Rename follow: the seen set moves with the file. */
export function moveSeenLines(owner: OwnerKey, fromPath: string, toPath: string, newGeneration: string): void {
  const files = ledgerFor(owner, fromPath)
  const entry = files.get(fromPath)
  if (!entry) return
  files.delete(fromPath)
  files.set(toPath, { generation: newGeneration, ranges: entry.ranges })
}

export function dropSeenLines(owner: OwnerKey, path: string): void {
  store.peek(owner)?.files.delete(path)
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetSeenLinesForTesting(): void {
  store.clearAllForShutdown()
}
