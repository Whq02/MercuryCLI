
export const SHIMMER_TICK_MS = 80
export const SHIMMER_GREETING_MS = 10_000
export const SHIMMER_EASE_IN_MS = 350
export const SHIMMER_EASE_OUT_MS = 1500
export const SHIMMER_LEG_MS_PER_CELL = 55
export const SHIMMER_LEG_MIN_MS = 1300
export const SHIMMER_LEG_MAX_MS = 3200
export const SHIMMER_LIFT = 0.85
export const SHIMMER_GAIN_LEVELS = 5

export function shimmerRadius(spanCells: number): number {
  return Math.max(3, Math.min(8, Math.round(spanCells * 0.28)))
}

export function shimmerLegMs(spanCells: number): number {
  return Math.max(
    SHIMMER_LEG_MIN_MS,
    Math.min(SHIMMER_LEG_MAX_MS, spanCells * SHIMMER_LEG_MS_PER_CELL),
  )
}

export type ShimmerPhase = {
  peakCell: number
  gainLevel: number
  radiusCells: number
}

export function shimmerEnvelope(elapsedMs: number): number {
  if (elapsedMs <= 0 || elapsedMs >= SHIMMER_GREETING_MS) return 0
  const easeOutStart = SHIMMER_GREETING_MS - SHIMMER_EASE_OUT_MS
  if (elapsedMs < SHIMMER_EASE_IN_MS) {
    const x = elapsedMs / SHIMMER_EASE_IN_MS
    return x * x
  }
  if (elapsedMs > easeOutStart) {
    const x = (SHIMMER_GREETING_MS - elapsedMs) / SHIMMER_EASE_OUT_MS
    return x * x
  }
  return 1
}

export function shimmerPeakAt(elapsedMs: number, spanCells: number): number {
  if (spanCells <= 1) return 0
  const leg = shimmerLegMs(spanCells)
  const tau = (elapsedMs % (2 * leg)) / (2 * leg)
  return ((1 - Math.cos(tau * 2 * Math.PI)) / 2) * (spanCells - 1)
}

export const SHIMMER_SETTLED = 'settled'

export function shimmerPhaseKey(elapsedMs: number, spanCells: number): string {
  if (elapsedMs >= SHIMMER_GREETING_MS) return SHIMMER_SETTLED
  const gainLevel = Math.round(shimmerEnvelope(elapsedMs) * SHIMMER_GAIN_LEVELS)
  if (gainLevel <= 0) return 'g0'
  const peakCell = Math.round(shimmerPeakAt(elapsedMs, spanCells))
  return `${peakCell}:${gainLevel}`
}

export function shimmerPhaseOf(key: string, spanCells: number): ShimmerPhase | null {
  if (key === SHIMMER_SETTLED || key === 'g0') return null
  const sep = key.indexOf(':')
  if (sep <= 0) return null
  const peakCell = Number(key.slice(0, sep))
  const gainLevel = Number(key.slice(sep + 1))
  if (!Number.isFinite(peakCell) || !Number.isFinite(gainLevel) || gainLevel <= 0) return null
  return { peakCell, gainLevel, radiusCells: shimmerRadius(spanCells) }
}

export function shimmerBoostAt(cellCenter: number, phase: ShimmerPhase): number {
  const d = Math.abs(cellCenter - phase.peakCell)
  if (d >= phase.radiusCells) return 0
  const w = Math.cos((d / phase.radiusCells) * (Math.PI / 2))
  return SHIMMER_LIFT * (phase.gainLevel / SHIMMER_GAIN_LEVELS) * w * w
}
