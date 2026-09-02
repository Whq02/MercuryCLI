// ============================================================================
//  render-engine/scheduler.ts — scheduling follows cost (laws E5, E6).
//
//  Rendering is demand-driven: nothing paints when nothing asks. Demands
//  land as requests; the scheduler decides WHEN composition runs:
//
//  · CADENCE — a leading+trailing 16ms window (one paint per interval under
//    a sustained burst, never two).
//  · ADAPTIVE COST FLOOR (E5) — after a frame costing C ms the next frame
//    starts no sooner than max(cadence, 2×C) capped at 200ms, so a heavy
//    transcript degrades to a slower cadence instead of a saturated CPU and
//    a lengthening queue.
//  · INPUT PRIORITY (E5) — a keystroke schedules an immediate paint of the
//    composer-bearing tail, bypassing the cost floor (cadence still caps the
//    rate); heavier content keeps waiting.
//  · CHOKE GATE (E6) — while the terminal owes more than the high-water
//    backlog, the engine does not COMPOSE at all: the demand survives as a
//    pending intent and retries shortly, so a slow terminal receives only
//    fresh frames, never a backlog of stale ones.
//  · RESIZE HOLD (E7) — while a WINCH storm is in flight every demand parks
//    as pending; the settle gate triggers the one settled reflow.
//
//  Composition itself is the engine's affair: the scheduler calls paint(kind)
//  and reads back the frame's cost.
// ============================================================================

import type { EngineClock } from './contracts.js'

export const CADENCE_MS = 16
export const COST_FLOOR_CAP_MS = 200
export const CHOKE_HIGH_WATER_BYTES = 256 * 1024
export const CHOKE_RETRY_MS = 10

export type PaintKind = 'normal' | 'input' | 'holding' | 'settled'

export interface SchedulerDeps {
  /** Compose + enqueue one frame now; returns the compose cost in ms. */
  paint(kind: PaintKind): number
  /** The door's drain truth. */
  owedBytes(): number
  clock: EngineClock
  /** The choke bound (E6): order 256KB by default; a profile may tighten it
   *  for a known-slow terminal class. */
  chokeHighWaterBytes?: number
}

export class PaintScheduler {
  private lastPaintAt = -Infinity
  private lastCost = 0
  private pendingNormal = false
  private pendingInput = false
  private held = false
  private timer: unknown = null
  private chokeDeferrals = 0
  private floorDeferrals = 0

  constructor(private readonly deps: SchedulerDeps) {}

  metrics(): { chokeDeferrals: number; floorDeferrals: number } {
    return { chokeDeferrals: this.chokeDeferrals, floorDeferrals: this.floorDeferrals }
  }

  /** A content demand (stream delta, settled batch, chrome change). */
  request(): void {
    this.pendingNormal = true
    this.evaluate()
  }

  /** A keystroke demand — echo paints ahead of heavy content (E5). */
  requestInput(): void {
    this.pendingInput = true
    this.evaluate()
  }

  /** Resize-storm hold: demands park as pending; nothing paints (E7). */
  hold(): void {
    this.held = true
  }

  /** Storm over: the caller paints the settled frame itself; parked demands
   *  are satisfied by that settled paint. */
  releaseAfterSettle(): void {
    this.held = false
    this.pendingNormal = false
    this.pendingInput = false
    this.lastPaintAt = this.deps.clock.now()
  }

  /** Plain release (fullscreen surface closed): parked demands survive and
   *  re-evaluate now. */
  release(): void {
    this.held = false
    this.evaluate()
  }

  private highWater(): number {
    return this.deps.chokeHighWaterBytes ?? CHOKE_HIGH_WATER_BYTES
  }

  /** The one cheap holding paint on storm entry (E7) — bypasses cadence
   *  (the storm gate itself rate-limits it) but still respects the choke. */
  paintHolding(): void {
    if (this.deps.owedBytes() > this.highWater()) return
    this.deps.paint('holding')
  }

  /** The one settled reflow after quiet (E7). */
  paintSettled(): void {
    this.lastCost = this.deps.paint('settled')
    this.lastPaintAt = this.deps.clock.now()
    this.releaseAfterSettle()
  }

  /** True when any demand is parked (probe port). */
  hasPending(): boolean {
    return this.pendingNormal || this.pendingInput
  }

  private floorMs(): number {
    return Math.max(CADENCE_MS, Math.min(2 * this.lastCost, COST_FLOOR_CAP_MS))
  }

  private evaluate = (): void => {
    if (this.held) return
    if (!this.pendingNormal && !this.pendingInput) return
    const now = this.deps.clock.now()

    // E6 first: never compose for a choked terminal. The intent survives.
    if (this.deps.owedBytes() > this.highWater()) {
      this.chokeDeferrals++
      this.arm(CHOKE_RETRY_MS)
      return
    }

    const sinceLast = now - this.lastPaintAt
    const inputOnly = this.pendingInput && !this.pendingNormal
    // Input bypasses the adaptive floor; plain cadence still caps the rate.
    const gateMs = this.pendingInput ? CADENCE_MS : this.floorMs()
    if (sinceLast < gateMs) {
      if (!inputOnly && sinceLast < this.floorMs() && this.floorMs() > CADENCE_MS) {
        this.floorDeferrals++
      }
      this.arm(gateMs - sinceLast)
      return
    }

    const kind: PaintKind = this.pendingInput && !this.pendingNormal ? 'input' : 'normal'
    this.pendingNormal = false
    this.pendingInput = false
    this.lastCost = this.deps.paint(kind)
    this.lastPaintAt = this.deps.clock.now()
    // A demand that arrived during the paint re-evaluates on the timer.
    if (this.pendingNormal || this.pendingInput) this.arm(this.floorMs())
  }

  private arm(ms: number): void {
    if (this.timer !== null) return
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null
      this.evaluate()
    }, Math.max(1, ms))
  }

  /** Drop armed timers without painting (detach). */
  cancel(): void {
    if (this.timer !== null) {
      this.deps.clock.clearTimeout(this.timer)
      this.timer = null
    }
    this.pendingNormal = false
    this.pendingInput = false
    this.held = false
  }
}
