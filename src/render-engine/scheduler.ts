
import type { EngineClock } from './contracts.js'

export const CADENCE_MS = 16
export const COST_FLOOR_CAP_MS = 200
export const CHOKE_HIGH_WATER_BYTES = 256 * 1024
export const CHOKE_RETRY_MS = 10

export type PaintKind = 'normal' | 'input' | 'holding' | 'settled'

export interface SchedulerDeps {
  paint(kind: PaintKind): number
  owedBytes(): number
  clock: EngineClock
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

  request(): void {
    this.pendingNormal = true
    this.evaluate()
  }

  requestInput(): void {
    this.pendingInput = true
    this.evaluate()
  }

  hold(): void {
    this.held = true
  }

  releaseAfterSettle(): void {
    this.held = false
    this.pendingNormal = false
    this.pendingInput = false
    this.lastPaintAt = this.deps.clock.now()
  }

  release(): void {
    this.held = false
    this.evaluate()
  }

  private highWater(): number {
    return this.deps.chokeHighWaterBytes ?? CHOKE_HIGH_WATER_BYTES
  }

  paintHolding(): void {
    if (this.deps.owedBytes() > this.highWater()) return
    this.deps.paint('holding')
  }

  paintSettled(): void {
    this.lastCost = this.deps.paint('settled')
    this.lastPaintAt = this.deps.clock.now()
    this.releaseAfterSettle()
  }

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

    if (this.deps.owedBytes() > this.highWater()) {
      this.chokeDeferrals++
      this.arm(CHOKE_RETRY_MS)
      return
    }

    const sinceLast = now - this.lastPaintAt
    const inputOnly = this.pendingInput && !this.pendingNormal
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
    if (this.pendingNormal || this.pendingInput) this.arm(this.floorMs())
  }

  private arm(ms: number): void {
    if (this.timer !== null) return
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null
      this.evaluate()
    }, Math.max(1, ms))
  }

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
