/**
 * Defence against hidden-character attacks: invisible characters that
 * smuggle instructions a model processes but a user cannot see. Always on.
 */

const MAX_PASSES = 10

// The primary defence: format, private-use and unassigned general categories
// via Unicode property classes.
const PROPERTY_CLASS_STRIP = /[\p{Cf}\p{Co}\p{Cn}]/gu

// The second line, because property classes have failed in some runtimes and
// the defence must not depend on them alone (contract data): zero-width and
// directional marks, directional formatting, directional isolates, the BOM,
// and the basic-plane private-use area.
const EXPLICIT_RANGE_STRIP = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uE000-\uF8FF]/g

/**
 * Iterates to a fixed point (compatibility composition, then both strips),
 * capped at 10 passes. Clean non-empty input costs exactly one pass; the
 * empty string costs none. Hitting the cap throws loudly — legitimate text
 * converges in a pass or two, and an input still changing after ten passes
 * is either a sanitiser defect or a construction, both deserving a visible
 * failure.
 */
export function partiallySanitizeUnicode(prompt: string): string {
  let previous = prompt
  let current = prompt
  let passes = 0
  for (;;) {
    if (passes >= MAX_PASSES) {
      throw new Error(
        `Unicode sanitization did not converge within ${MAX_PASSES} passes; input begins: ${prompt.slice(0, 100)}`,
      )
    }
    current = previous.normalize('NFKC').replace(PROPERTY_CLASS_STRIP, '').replace(EXPLICIT_RANGE_STRIP, '')
    passes++
    if (current === previous) return current
    previous = current
  }
}

export function recursivelySanitizeUnicode(value: string): string
export function recursivelySanitizeUnicode<T>(value: T[]): T[]
export function recursivelySanitizeUnicode<T extends object>(value: T): T
export function recursivelySanitizeUnicode<T>(value: T): T
export function recursivelySanitizeUnicode(value: unknown): unknown {
  if (typeof value === 'string') return partiallySanitizeUnicode(value)
  if (Array.isArray(value)) return value.map(item => recursivelySanitizeUnicode(item))
  if (value !== null && typeof value === 'object') {
    // Both keys and values, into a fresh plain object (class instances do
    // not survive as themselves).
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[partiallySanitizeUnicode(key)] = recursivelySanitizeUnicode(entry)
    }
    return result
  }
  return value
}
