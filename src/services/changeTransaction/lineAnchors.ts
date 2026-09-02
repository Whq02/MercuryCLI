// ============================================================================
//  changeTransaction/lineAnchors — per-line content-hash anchors (the
//  hashline layer). Pure math, no fs, no React; the one gate reader rides
//  flagRegistry the way hunks.ts does.
//
//  Grammar (the visible read prefix IS the copyable address):
//    <n>#<hex4>              one line — the 1-based number + the first 4 hex
//                            of sha256 over that line's exact text
//    <n>#<hex4>-<m>#<hex4>   inclusive range — BOTH endpoints carry hashes
//
//  Hash domain: the '\n'-split lines of normalizeForAnchor'd content (CRLF
//  → LF, a leading BOM dropped), each line's EXACT text — leading/trailing
//  whitespace included, never trimmed, never NFC-normalized (content
//  differing in codepoints IS different content, the snapshotAnchor law);
//  the empty line hashes the empty string. Presentation and verification
//  both hash THIS domain, so a CRLF or BOM'd file anchors identically from
//  either side. A lone-\r (classic-Mac) file is ONE domain line however the
//  plain presentation wraps it — its anchors verify against that one line
//  or refuse typed; anchors never guess.
//
//  POSITION IS THE AUTHORITY; the hash is a content tripwire. External
//  drift is refused wholesale by the readFileState staleness gate before
//  any hash is consulted, so the hash guards the self-drift chaining path:
//  a wrong-line apply needs BOTH a positional mis-aim AND a 2^-16 collision
//  on the mis-aimed line. Identical lines share a hash and NEVER share an
//  address — the line number is the disambiguator. LINE_ANCHOR_HEX widens
//  on evidence (a field wrong-line apply moves it), never on taste.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { runtimeKernel } from '../primitives/runtimeKernel.js'
import { changeTransactionEnabled } from './contracts.js'
import { normalizeForAnchor } from './snapshotAnchor.js'

/** The hashline gate (composes with the change-transaction layer — anchors
 *  are the staleness contract there too). Read live on every call. */
export function lineAnchorsEnabled(): boolean {
  return changeTransactionEnabled() && !isEnvDefinedFalsy(flagEnv('MERCURY_LINE_ANCHORS'))
}

/** Hash width in hex chars (16 bits). Widens on evidence — see header. */
export const LINE_ANCHOR_HEX = 4

/** Context lines answered on each side of a touched span. */
export const NEIGHBORHOOD_CONTEXT_LINES = 2

/** Total rows a neighborhood answer may carry before middle elision. */
export const NEIGHBORHOOD_ROW_CAP = 30

/** Search radius (lines each side of the aim) for relocation candidates. */
export const RELOCATION_SEARCH_RADIUS = 40

/** Most relocation candidates a refusal names. */
export const RELOCATION_CANDIDATE_CAP = 3

/** The per-line content hash: first LINE_ANCHOR_HEX of sha256 over the
 *  line's exact domain text. */
export function mintLineHash(lineText: string): string {
  return runtimeKernel().hash.sha256Hex(lineText).slice(0, LINE_ANCHOR_HEX)
}

/** The hash-domain lines of (possibly CRLF/BOM'd) content. The final
 *  newline is not a line — the same law as hunks.ts countLines, so anchor
 *  bounds and hunk bounds can never disagree. */
export function anchorDomainLines(content: string): string[] {
  const normalized = normalizeForAnchor(content)
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (normalized.endsWith('\n')) lines.pop()
  return lines
}

/** `<n>#<hex4>` for one line of domain text. */
export function formatLineAnchor(lineNumber: number, lineText: string): string {
  return `${lineNumber}#${mintLineHash(lineText)}`
}

// ── the presentation sibling ────────────────────────────────────────────────

/**
 * The anchored twin of utils/file.ts addLineNumbers: the SAME line split
 * (so anchored and plain reads are row-for-row identical) with the per-line
 * hash spliced into the prefix. Compact: `N#hhhh<TAB>line`. Legacy: the
 * `N#hhhh` left-padded to width 11 plus the arrow (6-digit-and-up numbers
 * unpadded, as the plain shape does at width 6).
 *
 * Hashing mirrors the anchor domain: a leading BOM never reaches the first
 * line's hash (normalizeForAnchor drops it at verification, so the
 * presentation drops it here). Rendering keeps the BOM out of the row text
 * too — the model re-quoting a first line must never carry an invisible
 * codepoint the file's edit domain will keep but its own eyes cannot see.
 */
export function addAnchoredLineNumbers({
  content,
  startLine,
  compact,
}: {
  content: string
  startLine: number
  compact: boolean
}): string {
  if (content === '') return ''
  const unmarked =
    startLine === 1 && content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  return unmarked
    .split(/\r\n|\r|\n/)
    .map((line, index) => {
      const lineNumber = startLine + index
      const prefix = `${lineNumber}#${mintLineHash(line)}`
      if (compact) return `${prefix}\t${line}`
      return prefix.length >= 11 ? `${prefix}→${line}` : `${prefix.padStart(11, ' ')}→${line}`
    })
    .join('\n')
}

// ── parsing ─────────────────────────────────────────────────────────────────

export interface LineRef {
  line: number
  hash: string
}

const LINE_REF_RE = new RegExp(`^(\\d+)#([0-9a-f]{${LINE_ANCHOR_HEX}})$`)

/** Parse one `<n>#<hex4>` reference; null when not that shape. */
export function parseLineRef(spelling: string): LineRef | null {
  const m = LINE_REF_RE.exec(spelling)
  if (!m) return null
  const line = Number(m[1])
  if (!Number.isSafeInteger(line) || line < 1) return null
  return { line, hash: m[2]! }
}

export type HashedLinesParse =
  | { ok: true; start: LineRef; end: LineRef }
  | { ok: false; message: string }
  | null

/**
 * Parse a hash-qualified `lines` spelling: `N#hhhh` or `N#hhhh-M#gggg`.
 * Returns null when the spelling carries no '#' at all (not hash-shaped —
 * the caller's plain grammar owns it); a '#'-bearing spelling that does not
 * parse whole is a typed refusal, never a silent fall-through.
 */
export function parseHashedLinesSpelling(spelling: string): HashedLinesParse {
  const trimmed = spelling.trim()
  if (!trimmed.includes('#')) return null
  const parts = trimmed.split('-')
  if (parts.length > 2) {
    return { ok: false, message: `'${spelling}' does not parse — a hash-qualified range is "N#hhhh-M#gggg" (one dash)` }
  }
  const start = parseLineRef(parts[0]!)
  if (!start) {
    return { ok: false, message: `'${spelling}' does not parse — a hash-qualified line is "N#hhhh" (${LINE_ANCHOR_HEX} lowercase hex from the anchored read)` }
  }
  if (parts.length === 1) return { ok: true, start, end: start }
  const end = parseLineRef(parts[1]!)
  if (!end) {
    return { ok: false, message: `'${spelling}' half-qualifies its range — carry BOTH endpoint anchors ("N#hhhh-M#gggg"), exactly as the anchored read presented them` }
  }
  if (end.line < start.line) {
    return { ok: false, message: `'${spelling}' ends before it starts` }
  }
  return { ok: true, start, end }
}

// ── verification ────────────────────────────────────────────────────────────

export type LineRefCheck =
  | { ok: true }
  | {
      ok: false
      line: number
      expectedHash: string
      /** The hash the line carries NOW; null when the line is out of bounds. */
      currentHash: string | null
    }

/** Verify one reference against the hash-domain lines; position first. */
export function verifyLineRef(domainLines: string[], ref: LineRef): LineRefCheck {
  if (ref.line < 1 || ref.line > domainLines.length) {
    return { ok: false, line: ref.line, expectedHash: ref.hash, currentHash: null }
  }
  const current = mintLineHash(domainLines[ref.line - 1]!)
  if (current !== ref.hash) {
    return { ok: false, line: ref.line, expectedHash: ref.hash, currentHash: current }
  }
  return { ok: true }
}

// ── the recovery answers ────────────────────────────────────────────────────

/**
 * Anchored rows for the touched span plus NEIGHBORHOOD_CONTEXT_LINES each
 * side, clamped to the file, middle-elided past NEIGHBORHOOD_ROW_CAP. The
 * rows are compact-shaped (`N#hhhh<TAB>text`) — a recovery answer, not a
 * themed paint.
 */
export function neighborhoodRows(
  domainLines: string[],
  spanStart: number,
  spanEnd: number,
  context: number = NEIGHBORHOOD_CONTEXT_LINES,
  cap: number = NEIGHBORHOOD_ROW_CAP,
): string[] {
  if (domainLines.length === 0) return []
  const from = Math.max(1, Math.min(spanStart, spanEnd) - context)
  const to = Math.min(domainLines.length, Math.max(spanStart, spanEnd) + context)
  const row = (n: number): string => `${formatLineAnchor(n, domainLines[n - 1]!)}\t${domainLines[n - 1]!}`
  const total = to - from + 1
  if (total <= cap) {
    const rows: string[] = []
    for (let n = from; n <= to; n++) rows.push(row(n))
    return rows
  }
  const head = Math.ceil((cap - 1) / 2)
  const tail = cap - 1 - head
  const rows: string[] = []
  for (let n = from; n < from + head; n++) rows.push(row(n))
  rows.push(`… ${total - head - tail} more line(s) — re-read for the full window …`)
  for (let n = to - tail + 1; n <= to; n++) rows.push(row(n))
  return rows
}

/**
 * The typed stale-line-anchor refusal: names the failing hunk and line,
 * answers the current anchor at that position, the bounded "moved_to"
 * candidates, and the current anchors for the touched neighborhood — so
 * recovery is one re-aim from the refusal itself, never a blind retry.
 * The engine NEVER relocates on its own; a diverged anchor always refuses.
 */
export function formatStaleLineAnchorRefusal(opts: {
  hunkIndex: number
  spelling: string
  failure: Extract<LineRefCheck, { ok: false }>
  domainLines: string[]
}): string {
  const { hunkIndex, spelling, failure, domainLines } = opts
  const out: string[] = []
  if (failure.currentHash === null) {
    out.push(
      `hunk ${hunkIndex}: stale line anchor — '${spelling}' addresses line ${failure.line}, but the file has ${domainLines.length} line(s).`,
    )
  } else {
    out.push(
      `hunk ${hunkIndex}: stale line anchor — line ${failure.line} no longer carries #${failure.expectedHash} (current: ${failure.line}#${failure.currentHash}).`,
    )
  }
  const candidates = findRelocationCandidates(domainLines, failure.expectedHash, failure.line)
  if (candidates.length > 0) {
    out.push(`moved_to: ${candidates.map(n => formatLineAnchor(n, domainLines[n - 1]!)).join('  ')}`)
  }
  if (domainLines.length > 0) {
    const center = Math.min(Math.max(1, failure.line), domainLines.length)
    const from = Math.max(1, center - NEIGHBORHOOD_CONTEXT_LINES)
    const to = Math.min(domainLines.length, center + NEIGHBORHOOD_CONTEXT_LINES)
    out.push(`current anchors (lines ${from}-${to}):`)
    out.push(...neighborhoodRows(domainLines, center, center))
  }
  out.push('Re-aim at the anchors above (or re-read the file if the drift is wider).')
  return out.join('\n')
}

/**
 * The post-apply answer: fresh anchors for every touched region of the
 * UPDATED content (each region ± context, capped) — so a chain of anchored
 * edits keeps going without a re-read, the shift the model's own edit just
 * caused already re-anchored in its result. Deletions answer the seam.
 */
export function formatFreshAnchorBlocks(
  domainLines: string[],
  regions: Array<{ start: number; lineCount: number }>,
): string {
  if (domainLines.length === 0 || regions.length === 0) return ''
  const out: string[] = ['fresh anchors:']
  for (const region of regions) {
    if (region.lineCount === 0) {
      const seamStart = Math.max(1, Math.min(region.start - 1, domainLines.length))
      const seamEnd = Math.min(domainLines.length, Math.max(seamStart, region.start))
      out.push(`lines ${seamStart}-${seamEnd} (around the removal) now:`)
      out.push(...neighborhoodRows(domainLines, seamStart, seamEnd))
    } else {
      const end = Math.min(domainLines.length, region.start + region.lineCount - 1)
      out.push(`lines ${region.start}-${end} now:`)
      out.push(...neighborhoodRows(domainLines, region.start, end))
    }
  }
  return out.join('\n')
}

/**
 * Positions near the aim whose CURRENT line text carries the expected hash
 * — the "your line moved" candidates. Ordered by distance from the aim,
 * bounded by radius and cap. Candidates are an ANSWER for the model's
 * re-aim; the engine itself never relocates.
 */
export function findRelocationCandidates(
  domainLines: string[],
  expectedHash: string,
  aim: number,
  radius: number = RELOCATION_SEARCH_RADIUS,
  cap: number = RELOCATION_CANDIDATE_CAP,
): number[] {
  const from = Math.max(1, aim - radius)
  const to = Math.min(domainLines.length, aim + radius)
  const hits: number[] = []
  for (let n = from; n <= to; n++) {
    if (mintLineHash(domainLines[n - 1]!) === expectedHash) hits.push(n)
  }
  hits.sort((a, b) => Math.abs(a - aim) - Math.abs(b - aim) || a - b)
  return hits.slice(0, cap)
}
