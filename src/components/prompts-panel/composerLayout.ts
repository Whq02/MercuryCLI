// ============================================================================
//  composerLayout — the saved-prompt composer's height truth (FC-080).
//
//  The composer declared a two-row slot and then painted one unwindowed
//  line per COMPOSER_COLUMNS characters, so a paste near the store's
//  4000-char ceiling walked the panel's footer and bottom border off the
//  canvas. The slot now DECLARES what the buffer actually needs — capped,
//  so the list keeps breathing room — and the composer clips to the same
//  cap from the top (the tail window: the cursor lives at the end of a
//  paste). Pure math, provable without a terminal.
// ============================================================================

/** The composer's fixed wrap width (the TextInput's `columns`). */
export const COMPOSER_COLUMNS = 96

/** The slot's ceiling: header row + at most this many input rows — a
 *  4000-char paste must never eat the whole panel either. */
export const COMPOSER_SLOT_MAX_ROWS = 8

/** Rows the composer slot needs for a buffer of this length: 1 header row
 *  plus the wrapped input rows (+1 cell for the caret), capped. */
export function promptsComposerRows(bufferLength: number): number {
  const inputLines = Math.max(1, Math.ceil((bufferLength + 1) / COMPOSER_COLUMNS))
  return Math.min(1 + inputLines, COMPOSER_SLOT_MAX_ROWS)
}
