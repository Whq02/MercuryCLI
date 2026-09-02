// ============================================================================
//  changeTransaction/hunks — the anchored multi-hunk engine.
//
//  A compact, provider-neutral, STRUCTURED edit form built on Mercury's own
//  anchors (never a patch language): each hunk addresses 1-based lines of
//  the SAME snapshot the carried `expected_anchor` was minted from, with a
//  replacement body. Planning is pure and total:
//
//    · every range parses ("N" | "N-M"), is in bounds, and (for a range
//      anchor) falls inside the window the model actually read;
//    · hunks never overlap — every hunk occupies its closed line range
//      (inserts occupy their single anchor line), ANY intersection refuses
//      naming BOTH hunks; two inserts on one line are ambiguous → refuse;
//    · a plan failure names the failing hunk exactly and writes NOTHING.
//
//  Application is a descending splice over LF-normalized content (the
//  FileEdit owner normalizes on read and re-applies encoding + line endings
//  + final-newline state on write — this module never touches eol style).
//  One valid call produces ONE updated content — the owner's existing
//  patch/write/effect/receipt seams do the rest, so a multi-hunk edit mints
//  exactly one ChangeReceipt like any other edit.
//
//  Gate: MERCURY_EDIT_HUNKS (default-ON) AND the change-transaction layer
//  (anchors are the staleness contract). Either =0 ⇒ the field is absent
//  from the Edit schema and this module is never consulted.
//
//  Proof: scripts/edit-tools/prove-edit-hunks.ts (suite scripts/edit-tools/).
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { changeTransactionEnabled } from './contracts.js'
import {
  anchorDomainLines,
  formatStaleLineAnchorRefusal,
  lineAnchorsEnabled,
  parseHashedLinesSpelling,
  verifyLineRef,
  type LineRef,
} from './lineAnchors.js'
import { parseAnchor } from './snapshotAnchor.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** The S2 gate (composes with the change-transaction layer). */
export function editHunksEnabled(): boolean {
  return (
    changeTransactionEnabled() &&
    !isEnvDefinedFalsy(flagEnv('MERCURY_EDIT_HUNKS'))
  )
}

export interface EditHunkInput {
  /** 1-based original line ("12"), inclusive range ("12-18"), or — while
   *  the hashline layer is on — an anchor-qualified spelling copied from a
   *  line_anchors read ("12#ab3f", "12#ab3f-18#9c2e"), whose endpoint
   *  hashes are verified against the current content before anything is
   *  written. */
  lines: string
  /** Replacement body ("" deletes the range). With `insert`, the inserted body. */
  replace: string
  /** Insert relative to the single anchor line instead of replacing it. */
  insert?: 'before' | 'after'
}

export interface HunkSpan {
  index: number
  start: number
  end: number
  insert?: 'before' | 'after'
  replace: string
}

export type HunkPlan =
  | { ok: true; spans: HunkSpan[]; totalLines: number }
  | { ok: false; message: string }

function parseHunkRange(lines: string): { start: number; end: number } | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(lines.trim())
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  return { start, end }
}

/** Logical line count of LF-normalized content (final newline not a line). */
export function countLines(content: string): number {
  if (content === '') return 0
  const lines = content.split('\n')
  return content.endsWith('\n') ? lines.length - 1 : lines.length
}

/**
 * Validate every hunk against the SAME original snapshot. Never touches
 * the fs; the one gate read (lineAnchorsEnabled, taken once at entry)
 * decides whether anchor-qualified spellings parse — off, they refuse with
 * the exact plain-grammar message. The file-level anchor itself is checked
 * by the owner (checkAnchor); this plan enforces structure, bounds, the
 * read window, disjointness, and — for anchor-qualified hunks — that every
 * endpoint hash still matches the current content (a diverged line refuses
 * typed, and the refusal answers the current neighborhood anchors plus
 * bounded moved_to candidates; the plan never relocates on its own).
 */
export function planHunks(
  content: string,
  hunks: EditHunkInput[],
  expectedAnchor?: string,
): HunkPlan {
  if (hunks.length === 0) {
    return { ok: false, message: 'hunks is empty — provide at least one hunk or use old_string/new_string' }
  }
  const anchorsOn = lineAnchorsEnabled()
  let domainLines: string[] | null = null
  const totalLines = countLines(content)
  const parsedAnchor = expectedAnchor ? parseAnchor(expectedAnchor) : null
  const window =
    parsedAnchor?.kind === 'range'
      ? { start: parsedAnchor.startLine, end: parsedAnchor.startLine + parsedAnchor.lineCount - 1 }
      : null
  const spans: HunkSpan[] = []
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]!
    let range: { start: number; end: number } | null = null
    let refs: LineRef[] | null = null
    const hashed = anchorsOn ? parseHashedLinesSpelling(h.lines) : null
    if (hashed !== null) {
      if (!hashed.ok) {
        return { ok: false, message: `hunk ${i + 1}: ${hashed.message}` }
      }
      range = { start: hashed.start.line, end: hashed.end.line }
      refs = hashed.start.line === hashed.end.line ? [hashed.start] : [hashed.start, hashed.end]
    } else {
      range = parseHunkRange(h.lines)
    }
    if (!range) {
      return { ok: false, message: `hunk ${i + 1}: lines '${h.lines}' does not parse — use "N" or "N-M" (1-based, inclusive)` }
    }
    if (range.start < 1) {
      return { ok: false, message: `hunk ${i + 1}: lines are 1-based — '${h.lines}' starts below 1` }
    }
    if (range.end < range.start) {
      return { ok: false, message: `hunk ${i + 1}: range '${h.lines}' ends before it starts` }
    }
    if (h.insert && range.end !== range.start) {
      return { ok: false, message: `hunk ${i + 1}: insert takes a single anchor line, not a range ('${h.lines}')` }
    }
    if (h.insert && h.replace === '') {
      return { ok: false, message: `hunk ${i + 1}: insert with an empty body does nothing — drop the hunk` }
    }
    // Anchor-qualified endpoints verify BEFORE the generic bounds check so
    // an out-of-bounds or drifted ref gets the recovery-bearing refusal
    // (current neighborhood anchors + moved_to candidates), never a bare
    // count. THE STALENESS LAW: a diverged anchor refuses typed; the plan
    // never relocates on its own.
    if (refs) {
      if (domainLines === null) domainLines = anchorDomainLines(content)
      for (const ref of refs) {
        const verdict = verifyLineRef(domainLines, ref)
        if (!verdict.ok) {
          return {
            ok: false,
            message: formatStaleLineAnchorRefusal({
              hunkIndex: i + 1,
              spelling: h.lines,
              failure: verdict,
              domainLines,
            }),
          }
        }
      }
    }
    if (range.end > totalLines) {
      return { ok: false, message: `hunk ${i + 1}: lines '${h.lines}' out of bounds — the file has ${totalLines} line(s)` }
    }
    if (window && (range.start < window.start || range.end > window.end)) {
      return { ok: false, message: `hunk ${i + 1}: lines '${h.lines}' fall outside the read window L${window.start}-L${window.end} the range anchor covers — re-read the wider range first` }
    }
    spans.push({ index: i + 1, start: range.start, end: range.end, insert: h.insert, replace: h.replace })
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (cur.start <= prev.end) {
      return { ok: false, message: `hunk ${prev.index} and hunk ${cur.index} overlap (lines ${prev.start}-${prev.end} vs ${cur.start}-${cur.end}) — hunks must be disjoint` }
    }
  }
  return { ok: true, spans: sorted, totalLines }
}

function replacementLines(replace: string): string[] {
  if (replace === '') return []
  const body = replace.endsWith('\n') ? replace.slice(0, -1) : replace
  return body.split('\n')
}

/**
 * Apply a valid plan — descending source order, one splice per hunk.
 * Content and result are LF-domain; the caller owns eol/encoding restore.
 * Preserves the original final-newline state exactly.
 */
export function applyHunks(content: string, plan: Extract<HunkPlan, { ok: true }>): string {
  const hadTrailingNL = content.endsWith('\n')
  const lines = content === '' ? [] : content.split('\n')
  if (hadTrailingNL) lines.pop()
  for (let i = plan.spans.length - 1; i >= 0; i--) {
    const span = plan.spans[i]!
    const rep = replacementLines(span.replace)
    if (span.insert === 'before') {
      lines.splice(span.start - 1, 0, ...rep)
    } else if (span.insert === 'after') {
      lines.splice(span.end, 0, ...rep)
    } else {
      lines.splice(span.start - 1, span.end - span.start + 1, ...rep)
    }
  }
  if (lines.length === 0) return ''
  return lines.join('\n') + (hadTrailingNL ? '\n' : '')
}

/** The original text a span addresses (evidence + preview). */
export function spanText(content: string, span: HunkSpan): string {
  const lines = content.split('\n')
  return lines.slice(span.start - 1, span.end).join('\n')
}

/**
 * Where each applied span lands in the UPDATED content: 1-based start plus
 * the replacement's line count (0 for a deletion), walked ascending with
 * the cumulative length delta of earlier spans — the coordinates a
 * post-apply answer (fresh anchors) speaks in.
 */
export function planApplyRegions(
  plan: Extract<HunkPlan, { ok: true }>,
): Array<{ start: number; lineCount: number }> {
  let delta = 0
  const regions: Array<{ start: number; lineCount: number }> = []
  for (const span of plan.spans) {
    const rep = replacementLines(span.replace)
    if (span.insert === 'before') {
      regions.push({ start: span.start + delta, lineCount: rep.length })
      delta += rep.length
    } else if (span.insert === 'after') {
      regions.push({ start: span.end + delta + 1, lineCount: rep.length })
      delta += rep.length
    } else {
      const oldLen = span.end - span.start + 1
      regions.push({ start: span.start + delta, lineCount: rep.length })
      delta += rep.length - oldLen
    }
  }
  return regions
}

/**
 * Equivalent old/new pairs for the EXISTING permission-preview seam — each
 * hunk becomes one exact edit against the snapshot, so consent cards render
 * a truthful diff through the same components.
 */
export function hunksToEdits(
  content: string,
  plan: Extract<HunkPlan, { ok: true }>,
): Array<{ old_string: string; new_string: string; replace_all: boolean }> {
  return plan.spans.map(span => {
    const original = spanText(content, span)
    if (span.insert === 'before') {
      return { old_string: original, new_string: `${span.replace}\n${original}`, replace_all: false }
    }
    if (span.insert === 'after') {
      return { old_string: original, new_string: `${original}\n${span.replace}`, replace_all: false }
    }
    return { old_string: original, new_string: span.replace, replace_all: false }
  })
}
