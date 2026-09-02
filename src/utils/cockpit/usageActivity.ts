// ============================================================================
//  utils/cockpit/usageActivity — the session's REAL spend pulse (interaction-
//  finish). Pure + React-free.
//
//  There was no usage time-series anywhere (cost-tracker keeps totals; the
//  quota snapshot keeps the current window only), so the Usage panel had no
//  honest way to show "how active has this session been lately". This module
//  records one at the EXISTING settlement seam — cost-tracker's
//  addToTotalSessionCost runs once per main API response; recordUsagePulse
//  appends {atMs, costUSD} there — no polling loop, no new producer cadence,
//  no fabricated values: every point is a real billed response.
//
//  Bounded ring (last MAX_PULSES responses, session lifetime). The reader
//  bins cost over a trailing window for the rail's Sparkline; consumers gate
//  on ≥2 pulses (the honest "not enough signal yet" — render nothing).
// ============================================================================

const MAX_PULSES = 400

interface UsagePulse {
  atMs: number
  costUSD: number
}

const pulses: UsagePulse[] = []

/** Called from the cost settlement seam — one real API response landed. */
export function recordUsagePulse(costUSD: number, atMs: number = Date.now()): void {
  if (!(costUSD >= 0) || !Number.isFinite(atMs)) return
  pulses.push({ atMs, costUSD })
  if (pulses.length > MAX_PULSES) pulses.splice(0, pulses.length - MAX_PULSES)
}

/** Cost per bin over the trailing window (newest bin last), plus the number
 *  of REAL pulses inside the window — consumers require ≥2 to render. */
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

/** Test seam. */
export function resetUsageActivityForTest(): void {
  pulses.length = 0
}
