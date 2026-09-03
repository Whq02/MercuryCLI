// The pinned Unicode display-width oracle: ONE answer for "how many terminal
// cells does this string occupy". Every cell-width decision in the product
// resolves here — never introduce a second width table.

import emojiRegexFactory from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'

type NativeStringWidth = (
  input: string,
  options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
) => number

// Resolved ONCE at module scope — this is a hot path with order-100k calls
// per frame, so the runtime capability is never probed per call.
const nativeStringWidth: NativeStringWidth | undefined = (
  globalThis as { Bun?: { stringWidth?: NativeStringWidth } }
).Bun?.stringWidth

/**
 * True for the Hebrew niqqud/cantillation and Arabic harakat combining
 * marks. Exported so the display-ANSI path's legacy width carve-out
 * consults the SAME classification — both runtimes historically counted
 * these as spacing, so pointed Hebrew/Arabic over-measured and truncated
 * early. The spacing punctuation inside the same blocks (U+05BE, U+05C0,
 * U+05C3, U+05C6) stays width 1.
 */
export function isHebrewArabicCombiningMark(codePoint: number): boolean {
  if (codePoint >= 0x0591 && codePoint <= 0x05bd) return true
  if (
    codePoint === 0x05bf ||
    codePoint === 0x05c1 ||
    codePoint === 0x05c2 ||
    codePoint === 0x05c4 ||
    codePoint === 0x05c5 ||
    codePoint === 0x05c7
  ) {
    return true
  }
  if (codePoint >= 0x064b && codePoint <= 0x065f) return true
  return codePoint === 0x0670
}

// The native width function counts the mark set above as SPACING; any string
// containing one routes through the corrected implementation so the
// development runtime and the shipped runtime agree. One pre-compiled class
// test per call.
const HEBREW_ARABIC_MARK_RE =
  /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u064B-\u065F\u0670]/

// The native path bills the directional embeddings/overrides, the isolates
// and the Arabic letter mark ONE CELL (probed live: '\u202A' = 1, '\u2066'
// = 1, '\u061C' = 1 under Bun.stringWidth) — any string carrying one routes
// through the corrected implementation, the same discipline as the
// spacing-mark set above.
const DIRECTIONAL_FORMAT_RE = /[\u061C\u180E\u200E\u200F\u202A-\u202E\u2066-\u2069]/

function isZeroWidthCodePoint(codePoint: number): boolean {
  // Printable ASCII is never zero-width.
  if (codePoint >= 0x20 && codePoint <= 0x7e) return false
  // C0/C1 controls.
  if (codePoint <= 0x1f) return true
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true
  // In U+00A0–U+02FF only the soft hyphen is zero-width.
  if (codePoint >= 0xa0 && codePoint <= 0x2ff) return codePoint === 0xad
  // Zero-width space/joiners, the directional marks (LRM/RLM), BOM, the
  // word-joiner block and the directional isolates/embeddings/overrides:
  // Cf format characters occupy no cell on a
  // terminal; billing them 1 shifted the rest of the row for every string
  // carrying bidi controls (model prose quoting RTL text, file content).
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true
  if (codePoint === 0xfeff) return true
  if (codePoint >= 0x2060 && codePoint <= 0x2069) return true
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true
  // Arabic letter mark + the (deprecated, still Cf) Mongolian vowel separator.
  if (codePoint === 0x061c || codePoint === 0x180e) return true
  // Variation selectors.
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return true
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return true
  // Combining diacritics.
  if (codePoint >= 0x300 && codePoint <= 0x36f) return true
  if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return true
  if (codePoint >= 0x1dc0 && codePoint <= 0x1dff) return true
  if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return true
  if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return true
  if (isHebrewArabicCombiningMark(codePoint)) return true
  // Indic combining marks, selected by the low 7 bits of the code point.
  if (codePoint >= 0x900 && codePoint <= 0xd4f) {
    const offset = codePoint & 0x7f
    if (
      offset <= 0x03 ||
      (offset >= 0x3a && offset <= 0x4f) ||
      (offset >= 0x51 && offset <= 0x57) ||
      (offset >= 0x62 && offset <= 0x63)
    ) {
      return true
    }
  }
  // Thai/Lao combining marks. U+0E32/U+0E33/U+0EB2/U+0EB3 are SPACING vowels
  // of width 1 and are deliberately excluded.
  if (codePoint === 0x0e31) return true
  if (codePoint >= 0x0e34 && codePoint <= 0x0e3a) return true
  if (codePoint >= 0x0e47 && codePoint <= 0x0e4e) return true
  if (codePoint === 0x0eb1) return true
  if (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) return true
  if (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) return true
  // Arabic formatting characters.
  if (codePoint >= 0x600 && codePoint <= 0x605) return true
  if (codePoint === 0x6dd || codePoint === 0x70f || codePoint === 0x8e2) return true
  // Surrogates and tag characters.
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true
  return false
}

// Emoji ranges, variation selectors and ZWJ — presence forces the grapheme
// path; absence allows the per-code-point sum.
const EMOJI_TRIGGER_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/u

// The vendored pattern is a NON-unicode-mode regex (emoji-regex ships flags
// 'g' alone and spells astral emoji as surrogate escapes); compiling its
// source under 'u' turned every astral cluster into a non-match, so the
// per-code-point sum measured a thumbs-up with a skin-tone modifier and a
// man+ZWJ+laptop cluster as 4 and a two-adult ZWJ family as 6 while the
// grid paints 2 (WG-1). The anchored copy inherits the vendored flags minus
// the global one, so the source and its mode can never disagree again.
const EMOJI_CLUSTER_RE = (() => {
  const vendored = emojiRegexFactory()
  return new RegExp(`^(?:${vendored.source})$`, vendored.flags.replace('g', ''))
})()

function emojiClusterWidth(cluster: string, firstCodePoint: number): number {
  // A single regional indicator is width 1; a pair is 2.
  if (firstCodePoint >= 0x1f1e6 && firstCodePoint <= 0x1f1ff) {
    let count = 0
    for (const _ of cluster) count++
    return count === 1 ? 1 : 2
  }
  const codePoints: number[] = []
  for (const ch of cluster) codePoints.push(ch.codePointAt(0)!)
  // digit / # / * plus the emoji variation selector with no combining keycap.
  if (
    codePoints.length === 2 &&
    codePoints[1] === 0xfe0f &&
    ((firstCodePoint >= 0x30 && firstCodePoint <= 0x39) ||
      firstCodePoint === 0x23 ||
      firstCodePoint === 0x2a)
  ) {
    return 1
  }
  // A text-default dingbat with no explicit emoji-presentation selector must
  // not report 2, or a cell stored as wide advances the diff cursor two
  // columns for a one-cell glyph.
  if (codePoints.length === 1 && eastAsianWidth(firstCodePoint) === 1) return 1
  return 2
}

function clusterWidth(cluster: string): number {
  const firstCodePoint = cluster.codePointAt(0)!
  if (EMOJI_CLUSTER_RE.test(cluster)) {
    return emojiClusterWidth(cluster, firstCodePoint)
  }
  // A non-emoji cluster sums the East-Asian widths of EVERY spacing code
  // point: terminals allocate a cell per spacing base character even when
  // the font draws the run as one ligature, so a two-consonant conjunct
  // occupies two columns. Stopping after the first spacing code point
  // under-reports by a cell and every later write on that row lands one
  // column to the left.
  let width = 0
  for (const ch of cluster) {
    const codePoint = ch.codePointAt(0)!
    if (isZeroWidthCodePoint(codePoint)) continue
    width += eastAsianWidth(codePoint)
  }
  return width
}

function correctedWidth(text: string): number {
  if (!EMOJI_TRIGGER_RE.test(text)) {
    // Simple-Unicode fast path: East-Asian width with ambiguous as NARROW,
    // skipping zero-width code points.
    let width = 0
    for (const ch of text) {
      const codePoint = ch.codePointAt(0)!
      if (isZeroWidthCodePoint(codePoint)) continue
      width += eastAsianWidth(codePoint)
    }
    return width
  }
  const segmenter = getGraphemeSegmenter()
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    width += clusterWidth(segment)
  }
  return width
}

/** The corrected (non-native) path, exposed for the width pins: under bun the
 *  public door answers through Bun.stringWidth, so the shipped node path —
 *  the one the emoji-cluster regex governs — is otherwise unreachable from
 *  a prover. */
export const __correctedWidthForTest = correctedWidth

export function stringWidth(input: string): number {
  if (typeof input !== 'string' || input.length === 0) return 0

  // Pure-ASCII fast path: no code unit ≥ 127 and no escape byte.
  let asciiOnly = true
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code >= 127 || code === 0x1b) {
      asciiOnly = false
      break
    }
  }
  if (asciiOnly) {
    let width = 0
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) >= 0x20) width++
    }
    return width
  }

  let text = input
  if (text.includes('\x1b')) {
    text = stripAnsi(text)
    if (text.length === 0) return 0
  }

  if (nativeStringWidth && !HEBREW_ARABIC_MARK_RE.test(text) && !DIRECTIONAL_FORMAT_RE.test(text)) {
    return nativeStringWidth(text, {
      countAnsiEscapeCodes: false,
      ambiguousIsNarrow: true,
    })
  }
  return correctedWidth(text)
}
