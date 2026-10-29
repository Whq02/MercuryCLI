const MAX_PASSES = 10

const PROPERTY_CLASS_STRIP = /[\p{Cf}\p{Co}\p{Cn}]/gu

const EXPLICIT_RANGE_STRIP = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\uE000-\uF8FF]/g

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

    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      result[partiallySanitizeUnicode(key)] = recursivelySanitizeUnicode(entry)
    }
    return result
  }
  return value
}

export function hiddenCommandCharacterReason(command: string, includeCodePoint = true): string | null {
  const tag = (match: RegExpExecArray | null, base: string): string | null => {
    if (match === null) return null
    const code = match[0]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    return includeCodePoint ? `${base} (U+${code})` : base
  }
  return (
    tag(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.exec(command), 'Contains control characters') ??
    tag(/[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/.exec(command), 'Contains invisible Unicode whitespace characters') ??
    tag(/[\u200C-\u200F\u202A-\u202E\u2060-\u2069]/.exec(command), 'Contains invisible Unicode direction or zero-width characters')
  )
}
