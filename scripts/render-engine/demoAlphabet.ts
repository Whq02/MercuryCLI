
export const DEMO_GLYPHS = new Set<string>([
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
  '●', '❯', '…', '·',
  '─', '│', '╭', '╮', '╰', '╯',
])

export function textIsDemoLawful(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp <= 0x7e) continue
    if (DEMO_GLYPHS.has(ch)) continue
    return false
  }
  return true
}

export function firstUnlawfulGlyph(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp <= 0x7e) continue
    if (DEMO_GLYPHS.has(ch)) continue
    return ch
  }
  return null
}
