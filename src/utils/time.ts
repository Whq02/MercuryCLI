// ============================================================================
//  utils/time — compact duration formatters (single source of truth).
// ----------------------------------------------------------------------------
//  Two intentionally-distinct compact duration formats, each under a
//  self-describing name: one takes ms and prints "1h2m" (no space), the other
//  takes whole seconds and prints "1m 20s". A same-name twin with diverging
//  behavior is a footgun, so both live HERE and each call site imports the one
//  it needs. Pure (numbers in, strings out), so callers stay unit-testable
//  under `bun run`.
// ============================================================================

/** ms → a compact human duration ("45s" / "8m" / "1h2m") — no separator, for
 *  tight inline status lines */
export function fmtElapsedMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}
