// The spinner/tool-card demo surface's declared content alphabet. The strict
// junk-bytes verifier admits printables from EXACTLY this set — any other
// glyph in the captured stream is a stray byte and fails the capture.

/** Non-ASCII glyphs the demo composes. */
export const DEMO_GLYPHS = new Set<string>([
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', // spinner frames
  '●', '❯', '…', '·',
  '─', '│', '╭', '╮', '╰', '╯',
])

/** True when every code point of a text run is demo-lawful: printable ASCII
 *  or a declared glyph. */
export function textIsDemoLawful(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp <= 0x7e) continue
    if (DEMO_GLYPHS.has(ch)) continue
    return false
  }
  return true
}

/** The first unlawful glyph, for the failure report. */
export function firstUnlawfulGlyph(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp <= 0x7e) continue
    if (DEMO_GLYPHS.has(ch)) continue
    return ch
  }
  return null
}
