
import { getIsScrollDraining } from '../../bootstrap/state.js'

type Bucket = {
  timer: ReturnType<typeof setInterval>
  subs: Set<() => void>
  windowStartMs: number
  windowCostMs: number
  overStreak: number
  underStreak: number
  degraded: boolean
  skipNext: boolean
  lastProbeMs: number
  probeStartMs: number
}

export const CLOCK_BUDGET_MS_PER_S = 40
const DEGRADE_WINDOWS = 2
const RECOVER_PROBES = 2
const PROBE_MS = 5000

let meterForProofs: { budgetMs: number; probeMs: number } | null = null
export function _setUiClockMeterForProofs(cfg: { budgetMs: number; probeMs: number } | null): void {
  meterForProofs = cfg
}

const buckets = new Map<number, Bucket>()

const lastTickByCadence = new Map<number, number>()

export function quantizedNow(ms: number): number {
  return Math.floor(Date.now() / ms) * ms
}

export function lastClockTick(ms: number): number {
  let stamp = lastTickByCadence.get(ms)
  if (stamp === undefined) {
    stamp = quantizedNow(ms)
    lastTickByCadence.set(ms, stamp)
  }
  return stamp
}

function fanOut(ms: number, bucket: Bucket): number {
  const t0 = performance.now()
  lastTickByCadence.set(ms, quantizedNow(ms))
  for (const s of bucket.subs) {
    try {
      s()
    } catch {
    }
  }
  return performance.now() - t0
}

function closeWindow(ms: number, bucket: Bucket, now: number, probe: boolean): void {
  const budget = (meterForProofs?.budgetMs ?? CLOCK_BUDGET_MS_PER_S) * Math.max(1, ms / 1000)
  const projected = bucket.degraded && !probe ? bucket.windowCostMs * 2 : bucket.windowCostMs
  if (bucket.degraded) {
    if (probe) {
      if (projected < budget / 2) {
        bucket.underStreak += 1
        if (bucket.underStreak >= RECOVER_PROBES) {
          bucket.degraded = false
          bucket.underStreak = 0
          bucket.overStreak = 0
          bucket.skipNext = false
        }
      } else {
        bucket.underStreak = 0
      }
    }
  } else if (projected > budget) {
    bucket.overStreak += 1
    if (bucket.overStreak >= DEGRADE_WINDOWS) {
      bucket.degraded = true
      bucket.overStreak = 0
      bucket.underStreak = 0
      bucket.lastProbeMs = now
      bucket.probeStartMs = 0
    }
  } else {
    bucket.overStreak = 0
  }
  bucket.windowStartMs = now
  bucket.windowCostMs = 0
}

function tick(ms: number, bucket: Bucket): void {
  if (getIsScrollDraining()) return
  const now = Date.now()
  if (bucket.windowStartMs === 0) bucket.windowStartMs = now
  const windowMs = Math.max(1000, ms)
  if (!bucket.degraded) {
    bucket.windowCostMs += fanOut(ms, bucket)
    if (now - bucket.windowStartMs >= windowMs || ms >= 1000) closeWindow(ms, bucket, now, false)
    return
  }
  const probeMs = meterForProofs?.probeMs ?? PROBE_MS
  if (bucket.probeStartMs === 0 && now - bucket.lastProbeMs >= probeMs) {
    bucket.probeStartMs = now
    bucket.windowStartMs = now
    bucket.windowCostMs = 0
  }
  const probing = bucket.probeStartMs !== 0
  if (!probing) {
    bucket.skipNext = !bucket.skipNext
    if (bucket.skipNext) return
  }
  bucket.windowCostMs += fanOut(ms, bucket)
  if (probing) {
    if (now - bucket.probeStartMs >= windowMs || ms >= 1000) {
      bucket.lastProbeMs = now
      bucket.probeStartMs = 0
      closeWindow(ms, bucket, now, true)
    }
  } else if (now - bucket.windowStartMs >= windowMs) {
    closeWindow(ms, bucket, now, false)
  }
}

export function subscribeUiClock(ms: number, cb: () => void): () => void {
  let bucket = buckets.get(ms)
  if (!bucket) {
    const subs = new Set<() => void>()
    lastTickByCadence.set(ms, quantizedNow(ms))
    const created: Bucket = {
      timer: setInterval(() => tick(ms, created), ms),
      subs,
      windowStartMs: 0,
      windowCostMs: 0,
      overStreak: 0,
      underStreak: 0,
      degraded: false,
      skipNext: false,
      lastProbeMs: 0,
      probeStartMs: 0,
    }
    created.timer.unref?.()
    bucket = created
    buckets.set(ms, bucket)
  }
  bucket.subs.add(cb)
  return () => {
    const b = buckets.get(ms)
    if (!b) return
    b.subs.delete(cb)
    if (b.subs.size === 0) {
      clearInterval(b.timer)
      buckets.delete(ms)
    }
  }
}

export function uiClockStatsForProofs(): Record<number, number> {
  const out: Record<number, number> = {}
  for (const [ms, b] of buckets) out[ms] = b.subs.size
  return out
}

export function uiClockPostureForProofs(): Record<number, boolean> {
  const out: Record<number, boolean> = {}
  for (const [ms, b] of buckets) out[ms] = b.degraded
  return out
}
