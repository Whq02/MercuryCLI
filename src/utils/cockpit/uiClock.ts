// ============================================================================
//  uiClock — ONE shared cadence scheduler for the TUI's wall-clock ticks
//
//
//  Before this, every useNowTick consumer owned a private setInterval: N
//  mounted age-rows = N × 1s timers, each waking the event loop and each
//  committing its own React render at its own phase. The cockpit at rest ran
//  half a dozen staggered 1s timers for identical information.
//
//  Model: one timer per DISTINCT CADENCE (the bucket), fanning out to every
//  subscriber of that cadence in one wake. Ticks are QUANTIZED to the
//  cadence (now = floor(Date.now()/ms)*ms) so subscribers that setState the
//  tick value bail out via Object.is when the quantized value hasn't moved —
//  the output-edge dedupe. During active scroll drain the tick is SKIPPED
//  (the getIsScrollDraining() contract every background interval honors):
//  age rows freeze ≤1 tick while frames need the loop, then resume.
//
//  Timers are unref'd and torn down when a bucket's last subscriber leaves —
//  the clock can never hold the process open (the fileStore ordering
//  doctrine applies here too).
// ============================================================================

import { getIsScrollDraining } from '../../bootstrap/state.js'

type Bucket = {
  timer: ReturnType<typeof setInterval>
  subs: Set<() => void>
}

const buckets = new Map<number, Bucket>()

/** The last tick STAMPED for each cadence — written only when subscribers
 *  are (or are about to be) notified: at bucket creation and immediately
 *  before each fan-out (never during scroll-drain-skipped ticks). This is
 *  what makes `lastClockTick` a pure store read: between notifications the
 *  stamp cannot move, so a getSnapshot deriving from it returns identical
 *  values across a mid-render wall-clock boundary crossing — where raw
 *  Date.now()/quantizedNow reads changed with zero notifications. */
const lastTickByCadence = new Map<number, number>()

/** floor(now / ms) * ms — the bucket-aligned tick value subscribers read. */
export function quantizedNow(ms: number): number {
  return Math.floor(Date.now() / ms) * ms
}

/**
 * The stored tick for cadence `ms` — the useSyncExternalStore-safe clock
 * read (advances only with a notification; see lastTickByCadence). Before
 * any subscriber exists the first read seeds a coherent lazy stamp, and
 * `subscribeUiClock` re-stamps at bucket creation so a long-dormant cadence
 * never serves a stale pre-subscription value past its mount commit.
 */
export function lastClockTick(ms: number): number {
  let stamp = lastTickByCadence.get(ms)
  if (stamp === undefined) {
    stamp = quantizedNow(ms)
    lastTickByCadence.set(ms, stamp)
  }
  return stamp
}

/**
 * Subscribe `cb` to the shared cadence `ms`. One interval per distinct
 * cadence serves every subscriber; returns the unsubscribe. `cb` fires at
 * most once per cadence period and never during active scroll drain.
 */
export function subscribeUiClock(ms: number, cb: () => void): () => void {
  let bucket = buckets.get(ms)
  if (!bucket) {
    const subs = new Set<() => void>()
    // Fresh stamp at bucket creation: a stale lazy stamp from a dormant
    // cadence must not survive into the live subscription (the mount
    // commit's snapshot re-check picks the fresh value up).
    lastTickByCadence.set(ms, quantizedNow(ms))
    const timer = setInterval(() => {
      if (getIsScrollDraining()) return
      // Stamp BEFORE fan-out, in the same synchronous block: the stamp and
      // the notification move together, never independently.
      lastTickByCadence.set(ms, quantizedNow(ms))
      for (const s of subs) {
        try {
          s()
        } catch {
          /* one throwing subscriber never blocks the bucket */
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

/** Proof/diagnostic seam: live bucket → subscriber-count map. */
export function uiClockStatsForProofs(): Record<number, number> {
  const out: Record<number, number> = {}
  for (const [ms, b] of buckets) out[ms] = b.subs.size
  return out
}
