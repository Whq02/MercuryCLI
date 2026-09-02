// ============================================================================
//  src/constants/figures.ts — single-codepoint glyph tokens other code
//  measures and matches. Invisible codepoints (the text-presentation
//  variation selector) are written as escapes; visible glyphs are literal.
//  Every token is width-1 unless noted.
// ============================================================================

/** Transcript tool-use bullet. */
export const BLACK_CIRCLE = '●'
export const BULLET_OPERATOR = '∙'
/** U+273B — width-1, not emoji. */
export const TEARDROP_ASTERISK = '✻'
/** Merge notice. */
export const UP_ARROW = '↑'
/** Scroll hint. */
export const DOWN_ARROW = '↓'
/** Fast-mode indicator (text zigzag, never the emoji bolt). */
export const LIGHTNING_BOLT = '↯'

/**
 * The output-connector token: a box-drawing corner plus a space — a
 * WIDTH-2-UNIT token, so every call site keeps identical surrounding-space
 * arithmetic. Caveat carried from the design record: the corner is
 * East-Asian Ambiguous, and a terminal rendering it wide desyncs from the
 * measured width.
 */
export const OUTPUT_CONNECTOR = '└ '

// The five effort dots.
// The low glyph is the hollow foot of the ladder, never the band's own ' · '
// separator: `Opus 5 · · low` read as a doubled separator, and the effort
// notification opened with what looked like a stray one.
export const EFFORT_LOW = '◦'
export const EFFORT_MEDIUM = '•'
export const EFFORT_HIGH = '●'
export const EFFORT_XHIGH = '◉'
export const EFFORT_MAX = '✦'

// (The base transport pair PLAY_ICON/PAUSE_ICON left with the permission-mode
// seal redesign — the mode tokens are GLYPH.mode* in mercury-ui/glyphs.ts.)

// MCP subscription indicators.
/** Resource update. */
export const REFRESH_ARROW = '↻'
/** Inbound channel message. */
export const CHANNEL_ARROW = '←'
/** Cross-session injected message indicator. */
export const INJECTED_ARROW = '→'
/** Fork directive. */
export const FORK_GLYPH = '⑂'

// Review-status diamonds: open = running, filled = completed/failed.
export const DIAMOND_OPEN = '◇'
export const DIAMOND_FILLED = '◆'
/** Away-summary recap mark. */
export const REFERENCE_MARK = '※'
export const FLAG_ICON = '⚑'

/** Left one-quarter block used as a line prefix. */
export const BLOCKQUOTE_BAR = '▎'
export const HEAVY_HORIZONTAL = '━'

/**
 * Four-frame bridge spinner: middle-dot, a rotating stroke, middle-dot —
 * strokes cycle vertical, forward slash, em dash, backslash.
 */
export const BRIDGE_SPINNER_FRAMES = [
  '·|·',
  '·/·',
  '·—·',
  '·\\·',
]

/**
 * Bridge ready: middle-dot, check mark WITH the text-presentation variation
 * selector (load-bearing — without it a terminal may render the check as a
 * double-width emoji and desync the width arithmetic), middle-dot. The
 * selector is written as an escape so it cannot be silently dropped.
 */
export const BRIDGE_READY_INDICATOR = '\u00B7\u2713\uFE0E\u00B7'

/**
 * Bridge failed: the multiplication-X codepoint the design kit standardized
 * on (U+2715 — never the banned multiplication-sign class). Duplicated as a
 * plain constant rather than imported from the component kit so this module
 * stays free of the components layer; kept in sync with the kit's failure
 * glyph.
 */
export const BRIDGE_FAILED_INDICATOR = '\u00B7\u2715\u00B7'
