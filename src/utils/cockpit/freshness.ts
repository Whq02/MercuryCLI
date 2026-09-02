
export type FreshnessTone = 'fresh' | 'stale'

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

export function freshnessTone(
  nowMs: number,
  atMs: number,
  staleMs: number,
): FreshnessTone {
  if (atMs <= 0) return 'fresh'
  return nowMs - atMs > staleMs ? 'stale' : 'fresh'
}
