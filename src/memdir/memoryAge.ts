// ============================================================================
//  src/memdir/memoryAge.ts — age arithmetic and the staleness caveat text.
// ============================================================================

const DAY_MS = 86_400_000

/** Floor of elapsed days, clamped at zero (future mtimes / clock skew → 0). */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / DAY_MS))
}

export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

/**
 * Empty for ages of 0 or 1 — a warning there is noise. Otherwise the
 * staleness caveat. Motivating report: stale code-state memories with
 * file-and-line citations were asserted as fact, and the citation made the
 * stale claim sound MORE authoritative.
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 1) return ''
  return `This memory was written ${days} days ago. A memory records an observation made at one moment, not the system's live state — claims about code behaviour and file-and-line citations may be outdated, and must be verified against the current code before being asserted as fact.`
}

/** The same text in a system-reminder wrapper; empty when the text is. */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (text === '') return ''
  return `<system-reminder>${text}</system-reminder>\n`
}
