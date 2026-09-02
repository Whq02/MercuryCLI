// ============================================================================
//  utils/inputRange — the ONE range-splice for composer text (interaction-
//  finish). PromptInput, useTextInput, the paste path, and the
//  insertion helpers all route range mutations through here so they can
//  never disagree on the splice math or the chip contract.
//
//  CHIP ATOMICITY: `[Pasted text #N …]` / `[Image #N]` / truncated-text
//  reference tokens are ATOMIC — a range that intersects one EXPANDS to
//  cover it whole, so an edit can never split a reference into invalid
//  text that would later fail to resolve. (The same tokens Cursor.ts treats
//  as single units for word-wise ops.)
// ============================================================================

export interface InputRange {
  start: number
  end: number
}

// The reference-token shapes history.ts writes (formatPastedTextRef /
// formatImageRef) and Cursor.ts recognizes as atomic units. F3:
// the pattern SOURCE is exported so every chip-atomicity guard (range
// expansion here, cursor hop/snap in Cursor.ts, the composer's chip
// select/invert machinery) derives from this ONE definition — text chips
// had drifted to image-only guards and were corruptible char-by-char.
export const CHIP_PATTERN =
  String.raw`\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]`
const CHIP_RE = new RegExp(CHIP_PATTERN, 'g')

/** Expand `range` so it never PARTIALLY overlaps a reference chip. */
export function expandRangeToChips(text: string, range: InputRange): InputRange {
  let { start, end } = range
  CHIP_RE.lastIndex = 0
  for (const m of text.matchAll(CHIP_RE)) {
    const cs = m.index
    const ce = m.index + m[0].length
    // Intersects (not merely touches) the chip → swallow it whole.
    if (start < ce && end > cs) {
      if (start > cs) start = cs
      if (end < ce) end = ce
    }
  }
  return { start, end }
}

/**
 * Replace `range` of `text` with `insert` — chip-safe. Returns the new text
 * and the cursor offset (end of the inserted run, the native-editor spot).
 */
export function spliceInputRange(
  text: string,
  range: InputRange,
  insert: string,
): { text: string; cursorOffset: number; range: InputRange } {
  const clamped: InputRange = {
    start: Math.max(0, Math.min(range.start, text.length)),
    end: Math.max(0, Math.min(range.end, text.length)),
  }
  const safe = expandRangeToChips(text, clamped)
  const next = text.slice(0, safe.start) + insert + text.slice(safe.end)
  return { text: next, cursorOffset: safe.start + insert.length, range: safe }
}
