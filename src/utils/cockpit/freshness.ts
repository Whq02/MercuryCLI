/**
 * freshness — the pure math behind the shared "↻ Ns ago" idiom (the
 * trust-cockpit program): a live surface LABELS how fresh its data is instead
 * of silently aging. Extracted from PartyBoard's header (the house gold
 * standard) so /trace /monitor /cockpit /daemon /ledger all say it one way.
 *
 * Leaf + bun-loadable (no react/ink/fs) so scripts/ui/prove-freshness.ts can
 * table-test it directly.
 */

/** Tone for the freshness label: AMBER once the data is older than staleMs. */
export type FreshnessTone = 'fresh' | 'stale'

/**
 * `↻ 3s ago` / `↻ 2m ago` / `↻ 4h ago`. Honest edges: an unset stamp (<=0)
 * reads `↻ —` (never a fabricated age); a stamp in the future reads
 * `↻ just now` (clock skew, mirrors healthCertCore.formatAge).
 */
export function formatFreshness(nowMs: number, atMs: number): string {
  if (atMs <= 0) return '↻ —'
  const delta = nowMs - atMs
  if (delta < 0) return '↻ just now'
  const s = Math.floor(delta / 1000)
  if (s < 60) return `↻ ${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `↻ ${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `↻ ${h}h ago`
  return `↻ ${Math.floor(h / 24)}d ago`
}

/** 'stale' once the stamp is set and older than staleMs (unset stays fresh-toned — the label already reads `↻ —`). */
export function freshnessTone(
  nowMs: number,
  atMs: number,
  staleMs: number,
): FreshnessTone {
  if (atMs <= 0) return 'fresh'
  return nowMs - atMs > staleMs ? 'stale' : 'fresh'
}
