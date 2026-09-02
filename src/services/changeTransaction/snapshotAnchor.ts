// ============================================================================
//  changeTransaction/snapshotAnchor — compact content-derived staleness
//  anchors. Pure: no fs, no env, no React.
//
//  Grammar (kept short — the model carries these verbatim):
//    fa:<hex12>                 — digest of the WHOLE file
//    ra:<hex12>:L<start>+<n>    — digest of the 1-based line range the read
//                                 actually returned (large/partial reads
//                                 never force a full-file hash)
//
//  Digests are sha256 over CRLF-normalized text (\r\n → \n) with a leading
//  byte-order mark dropped, truncated to 12 hex chars. Normalization
//  matches what the model actually sees (readFileSyncWithMetadata /
//  FileEdit.validateInput both normalize CRLF; the ranged Read strips the
//  BOM), so a CRLF file anchors identically from either side and so does a
//  BOM'd one — Read minted over BOM-stripped content while Edit/Write
//  checked BOM-inclusive content, so every anchored Edit on a BOM'd file
//  was born stale and the prescribed re-read changed nothing (TASK-014
//  w4-f02-03). Unicode is NOT normalized: content differing in codepoints
//  IS different content. 12 hex = 48 bits — a staleness check, not a
//  security boundary.
// ============================================================================

import { runtimeKernel } from '../primitives/runtimeKernel.js'

export type ParsedAnchor =
  | { kind: 'full'; digest: string }
  | { kind: 'range'; digest: string; startLine: number; lineCount: number }

export type AnchorCheck =
  | { ok: true }
  | {
      ok: false
      reason: 'stale' | 'malformed'
      /** The anchor the same scope mints against CURRENT content. */
      currentAnchor?: string
      /** The smallest reread that repairs the assumption. */
      rereadHint: string
    }

const ANCHOR_RE = /^(fa:[0-9a-f]{12}|ra:[0-9a-f]{12}:L\d+\+\d+)$/

export function normalizeForAnchor(text: string): string {
  const unmarked = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return unmarked.includes('\r\n') ? unmarked.replaceAll('\r\n', '\n') : unmarked
}

function digest12(normalized: string): string {
  // content hashing rides the ratified kernel boundary
  // (selected impl node:crypto — byte-identical to the previous inline
  // createHash; the parity gate pins reference === selected).
  return runtimeKernel().hash.sha256Hex(normalized).slice(0, 12)
}

/** Mint a whole-file anchor from (possibly unnormalized) file text. */
export function mintFileAnchor(content: string): string {
  return `fa:${digest12(normalizeForAnchor(content))}`
}

/**
 * Mint a range anchor from the RANGE text a partial read returned.
 * `startLine` is 1-based; `lineCount` is the number of lines returned.
 */
export function mintRangeAnchor(
  rangeContent: string,
  startLine: number,
  lineCount: number,
): string {
  return `ra:${digest12(normalizeForAnchor(rangeContent))}:L${startLine}+${lineCount}`
}

export function parseAnchor(anchor: string): ParsedAnchor | null {
  if (!ANCHOR_RE.test(anchor)) return null
  if (anchor.startsWith('fa:')) {
    return { kind: 'full', digest: anchor.slice(3) }
  }
  const m = anchor.match(/^ra:([0-9a-f]{12}):L(\d+)\+(\d+)$/)
  if (!m) return null
  const startLine = Number(m[2])
  const lineCount = Number(m[3])
  if (!Number.isFinite(startLine) || startLine < 1 || lineCount < 1) return null
  return { kind: 'range', digest: m[1]!, startLine, lineCount }
}

/** Slice the 1-based line range out of normalized full content. */
export function sliceRange(
  normalizedContent: string,
  startLine: number,
  lineCount: number,
): string {
  const lines = normalizedContent.split('\n')
  return lines.slice(startLine - 1, startLine - 1 + lineCount).join('\n')
}

/**
 * Check an expected anchor against the CURRENT full file content.
 * Range anchors re-digest the same 1-based range of the current content, so
 * an untouched region keeps its anchor even when the file changed elsewhere
 * only if the region's line positions still hold the same text.
 */
export function checkAnchor(
  expectedAnchor: string,
  currentFullContent: string,
  filePath: string,
): AnchorCheck {
  const parsed = parseAnchor(expectedAnchor)
  if (!parsed) {
    return {
      ok: false,
      reason: 'malformed',
      rereadHint: `expected_anchor '${expectedAnchor}' is not a valid anchor — re-read ${filePath} and use the (anchor: …) value from the result`,
    }
  }
  const normalized = normalizeForAnchor(currentFullContent)
  if (parsed.kind === 'full') {
    const current = `fa:${digest12(normalized)}`
    if (current === expectedAnchor) return { ok: true }
    return {
      ok: false,
      reason: 'stale',
      currentAnchor: current,
      rereadHint: `re-read ${filePath} (full file) to refresh the anchor`,
    }
  }
  const rangeText = sliceRange(normalized, parsed.startLine, parsed.lineCount)
  const current = `ra:${digest12(rangeText)}:L${parsed.startLine}+${parsed.lineCount}`
  if (current === expectedAnchor) return { ok: true }
  const endLine = parsed.startLine + parsed.lineCount - 1
  return {
    ok: false,
    reason: 'stale',
    currentAnchor: current,
    rereadHint: `re-read lines ${parsed.startLine}-${endLine} of ${filePath} (offset: ${parsed.startLine}, limit: ${parsed.lineCount}) to refresh the anchor`,
  }
}

/** The model-visible stale-anchor message (typed, machine-parseable lines). */
export function formatAnchorFailure(
  check: Extract<AnchorCheck, { ok: false }>,
  expectedAnchor: string,
): string {
  const lines = [
    check.reason === 'malformed'
      ? 'Malformed anchor: expected_anchor is not a valid anchor string.'
      : 'Stale anchor: the file content no longer matches the read that produced this anchor.',
    `expected_anchor: ${expectedAnchor}`,
  ]
  if (check.currentAnchor) lines.push(`current_anchor: ${check.currentAnchor}`)
  lines.push(`Reread: ${check.rereadHint}`)
  return lines.join('\n')
}
