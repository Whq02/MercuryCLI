import { CHOKE_RETRY_MS, cockpitEngine } from '../../render-engine/cockpit/engineMount.js'
import { FRAME_INTERVAL_MS } from '../constants.js'

export type SchedulerClock = {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (t: ReturnType<typeof setTimeout>) => void
  queueMicrotask: (fn: () => void) => void
}

const REAL_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t),
  queueMicrotask: fn => queueMicrotask(fn),
}

const BOOT_COALESCE_MS = 100
const PROBE_HOLD_STEP_MS = 16
const PROBE_HOLD_BUDGET_MS = 64

export type SchedulerState =
  | 'idle'
  | 'boot-hold'
  | 'window-open'
  | 'trailing-armed'
  | 'drain-armed'
  | 'settle-hold'

export class RenderScheduler {
  private readonly clock: SchedulerClock
  private readonly paint: () => void

  private windowOpenedAt = -Infinity
  private trailingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly bootUntil: number
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private settleHeld = false
  private pendingWhileHeld = false

  constructor(
    paint: () => void,
    clock: SchedulerClock = REAL_CLOCK,
    private readonly probeHold?: () => boolean,
  ) {
    this.clock = clock
    this.paint = paint
    this.bootUntil = clock.now() + BOOT_COALESCE_MS
  }

  private everInvoked = false
  private probeHoldSpentMs = 0
  private probeHoldTimer: ReturnType<typeof setTimeout> | null = null
  private chokeTimer: ReturnType<typeof setTimeout> | null = null

  private engine(): ReturnType<typeof cockpitEngine> {
    return cockpitEngine()
  }

  private windowMs(inputPriority: boolean): number {
    const engine = this.engine()
    if (engine === null || inputPriority) return FRAME_INTERVAL_MS
    return engine.floorMs()
  }

  private invoke = (): void => {
    if (
      !this.everInvoked &&
      this.probeHold?.() &&
      this.probeHoldSpentMs < PROBE_HOLD_BUDGET_MS
    ) {
      if (this.probeHoldTimer === null) {
        this.probeHoldSpentMs += PROBE_HOLD_STEP_MS
        this.probeHoldTimer = this.clock.setTimeout(() => {
          this.probeHoldTimer = null
          this.invoke()
        }, PROBE_HOLD_STEP_MS)
      }
      return
    }
    const engine = this.engine()
    if (engine?.choked() && this.chokeTimer === null) {
      engine.noteDeferral('choke')
      this.chokeTimer = this.clock.setTimeout(() => {
        this.chokeTimer = null
        this.invoke()
      }, CHOKE_RETRY_MS)
      return
    }
    if (this.chokeTimer !== null) return
    this.everInvoked = true
    this.windowOpenedAt = this.clock.now()
    this.clock.queueMicrotask(this.paint)
  }

  holdForSettle(): void {
    this.settleHeld = true
  }

  releaseSettleHold(flushPending: boolean): void {
    if (!this.settleHeld) return
    this.settleHeld = false
    const pending = this.pendingWhileHeld
    this.pendingWhileHeld = false
    if (flushPending && pending) this.requestFrame()
  }

  requestFrame = (): void => {
    if (this.settleHeld) {
      this.pendingWhileHeld = true
      return
    }
    const now = this.clock.now()
    if (now < this.bootUntil) {
      if (this.bootTimer === null) {
        this.bootTimer = this.clock.setTimeout(() => {
          this.bootTimer = null
          this.invoke()
        }, Math.max(1, this.bootUntil - now))
      }
      return
    }
    const engine = this.engine()
    const inputPriority = engine?.consumeInputPriority() ?? false
    const windowMs = this.windowMs(inputPriority)
    if (now - this.windowOpenedAt >= windowMs) {
      if (this.trailingTimer !== null) {
        this.clock.clearTimeout(this.trailingTimer)
        this.trailingTimer = null
      }
      this.invoke()
      return
    }
    if (engine !== null && !inputPriority && windowMs > FRAME_INTERVAL_MS) {
      engine.noteDeferral('floor')
    }
    const dueAt = this.windowOpenedAt + windowMs
    if (this.trailingTimer !== null && inputPriority) {
      this.clock.clearTimeout(this.trailingTimer)
      this.trailingTimer = null
    }
    if (this.trailingTimer === null) {
      this.trailingTimer = this.clock.setTimeout(() => {
        this.trailingTimer = null
        this.invoke()
      }, Math.max(1, dueAt - now))
    }
  }

  requestDrain(): void {
    if (this.settleHeld) {
      this.pendingWhileHeld = true
      return
    }
    if (this.drainTimer !== null) return
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = null
      this.paint()
    }, FRAME_INTERVAL_MS >> 2)
  }

  onRenderEntry(): void {
    if (this.drainTimer !== null) {
      this.clock.clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
  }

  cancel(): void {
    if (this.probeHoldTimer !== null) {
      this.clock.clearTimeout(this.probeHoldTimer)
      this.probeHoldTimer = null
    }
    if (this.chokeTimer !== null) {
      this.clock.clearTimeout(this.chokeTimer)
      this.chokeTimer = null
    }
    this.settleHeld = false
    this.pendingWhileHeld = false
    if (this.bootTimer !== null) {
      this.clock.clearTimeout(this.bootTimer)
      this.bootTimer = null
    }
    if (this.trailingTimer !== null) {
      this.clock.clearTimeout(this.trailingTimer)
      this.trailingTimer = null
    }
    this.onRenderEntry()
  }

  state(): SchedulerState {
    if (this.settleHeld) return 'settle-hold'
    if (this.bootTimer !== null) return 'boot-hold'
    if (this.drainTimer !== null) return 'drain-armed'
    if (this.trailingTimer !== null) return 'trailing-armed'
    if (this.clock.now() - this.windowOpenedAt < FRAME_INTERVAL_MS) return 'window-open'
    return 'idle'
  }
}
