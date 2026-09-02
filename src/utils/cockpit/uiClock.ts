
import { getIsScrollDraining } from '../../bootstrap/state.js'

type Bucket = {
  timer: ReturnType<typeof setInterval>
  subs: Set<() => void>
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

export function subscribeUiClock(ms: number, cb: () => void): () => void {
  let bucket = buckets.get(ms)
  if (!bucket) {
    const subs = new Set<() => void>()
    lastTickByCadence.set(ms, quantizedNow(ms))
    const timer = setInterval(() => {
      if (getIsScrollDraining()) return
      lastTickByCadence.set(ms, quantizedNow(ms))
      for (const s of subs) {
        try {
          s()
        } catch {
        }
      }
    }, ms)
    timer.unref?.()
    bucket = { timer, subs }
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
