
const MAX_PULSES = 400

interface UsagePulse {
  atMs: number
  costUSD: number
}

const pulses: UsagePulse[] = []

export function recordUsagePulse(costUSD: number, atMs: number = Date.now()): void {
  if (!(costUSD >= 0) || !Number.isFinite(atMs)) return
  pulses.push({ atMs, costUSD })
  if (pulses.length > MAX_PULSES) pulses.splice(0, pulses.length - MAX_PULSES)
}

export function usageActivityBins(
  nowMs: number,
  windowMs = 3_600_000,
  bins = 12,
): { perBin: number[]; pulses: number; totalUSD: number } {
  const perBin = new Array<number>(bins).fill(0)
  let count = 0
  let total = 0
  const binMs = windowMs / bins
  for (const p of pulses) {
    const age = nowMs - p.atMs
    if (age < 0 || age >= windowMs) continue
    const bin = bins - 1 - Math.floor(age / binMs)
    perBin[bin]! += p.costUSD
    count += 1
    total += p.costUSD
  }
  return { perBin, pulses: count, totalUSD: total }
}

export function resetUsageActivityForTest(): void {
  pulses.length = 0
}
