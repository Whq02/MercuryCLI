// ============================================================================
//  render-scheduler.ts — T6: the render-scheduling owner.
//
//  One owner for every path that would otherwise arm a paint: the 16ms
//  leading+trailing throttle, the 100ms boot-coalesce window, the microtask
//  deferral (layout effects — notably the cursor declaration — must commit
//  before onRender reads them; regression = one-keystroke caret lag), and the
//  quarter-interval scroll-drain timer. Policy is the shipped lattice
//  VERBATIM — swaps the policy inside this seam (input-first priority,
//  bounded queues) without another body hunt; do not tune here.
//
//  Clock-injected: laws drive {now, setTimeout, clearTimeout, queueMicrotask}
//  deterministically (scripts/core-runtime/prove-root-contract.ts).
//
//  Throttle semantics (the observable contract the old lodash dependency
//  provided, stated as spec):
//    • a request while IDLE (no window open) invokes on the LEADING edge and
//      opens a 16ms window;
//    • requests inside the window collapse into ONE TRAILING invocation at
//      the window boundary;
//    • a trailing invocation re-opens the window (back-to-back bursts sustain
//      one paint per interval, never two);
//    • cancel() drops any armed edge without invoking.
//  Boot coalesce: for the first 100ms after construction the leading edge is
//  suppressed and every request collapses into ONE flush at the window
//  boundary — the operator's first sight is a single settled frame.
//  Drain: a plain timeout at FRAME_INTERVAL_MS>>2 — deliberately NOT the
//  throttle (a trailing-edge invocation re-entering the throttle sees an
//  elapsed window and double-paints ~0.1ms apart); entering a render cancels
//  a pending drain so two paths never both fire.
// ============================================================================
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
// The FIRST paint may defer in 16ms steps while the capability probe's reply
// is still unprocessed (a busy boot loop serves due timers before stdin I/O,
// so the reply that would arm synchronized output loses the race to the
// first frame otherwise). Budgeted: a silent terminal pays at most ~64ms,
// once, before its first frame; an answering terminal releases the hold the
// moment the reply parses.
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

  // Throttle state: the window opens at every invocation; a request inside
  // the window arms the trailing edge.
  private windowOpenedAt = -Infinity
  private trailingTimer: ReturnType<typeof setTimeout> | null = null
  // Boot coalesce.
  private readonly bootUntil: number
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  // Scroll drain.
  private drainTimer: ReturnType<typeof setTimeout> | null = null
  // Resize-settle hold: while a WINCH storm is in flight the owner gates
  // every paint path; requests mark pending instead of invoking.
  private settleHeld = false
  private pendingWhileHeld = false

  constructor(
    paint: () => void,
    clock: SchedulerClock = REAL_CLOCK,
    /** True while the first paint should wait for an in-flight capability
     *  probe reply; consulted only before the first invoke and bounded by
     *  PROBE_HOLD_BUDGET_MS. */
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

  /** The engine gates (E5 cost floor · E6 choke), when the cockpit engine is
   *  mounted; null keeps the classic lattice byte-identical (flag off). */
  private engine(): ReturnType<typeof cockpitEngine> {
    return cockpitEngine()
  }

  /** The demand window for NORMAL demands: the classic cadence, widened to
   *  the engine's adaptive cost floor (max(cadence, 2×C) cap 200ms) when the
   *  mount is live (E5). Input-priority demands keep the plain cadence. */
  private windowMs(inputPriority: boolean): number {
    const engine = this.engine()
    if (engine === null || inputPriority) return FRAME_INTERVAL_MS
    return engine.floorMs()
  }

  /** Defer one paint to a microtask so React's layout phase (ref attach +
   *  useLayoutEffect, where the cursor declaration lands) commits first —
   *  same tick, so throughput is unchanged. */
  private invoke = (): void => {
    // First-paint probe hold: give the loop a few turns to process the
    // capability reply so the very first frame's wrap decision is informed.
    // Strictly bounded; released the moment the probe settles.
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
    // NEVER COMPOSE FOR A CHOKED TERMINAL (E6, engine-mounted only): while
    // the door owes past high water the demand survives as this armed retry
    // — a slow terminal receives only fresh frames, never a backlog.
    const engine = this.engine()
    if (engine?.choked() && this.chokeTimer === null) {
      engine.noteDeferral('choke')
      this.chokeTimer = this.clock.setTimeout(() => {
        this.chokeTimer = null
        this.invoke()
      }, CHOKE_RETRY_MS)
      return
    }
    if (this.chokeTimer !== null) return // a retry is already armed
    this.everInvoked = true
    this.windowOpenedAt = this.clock.now()
    this.clock.queueMicrotask(this.paint)
  }

  /** Open the resize-settle hold: paints are gated until release; commits
   *  keep landing (state and layout stay current underneath). Idempotent. */
  holdForSettle(): void {
    this.settleHeld = true
  }

  /** Close the settle hold. `flushPending` false DISCARDS frames requested
   *  during the hold — the caller is about to schedule the settled render
   *  itself and a flushed frame would compose the pre-settle layout. */
  releaseSettleHold(flushPending: boolean): void {
    if (!this.settleHeld) return
    this.settleHeld = false
    const pending = this.pendingWhileHeld
    this.pendingWhileHeld = false
    if (flushPending && pending) this.requestFrame()
  }

  /** The reconciler's per-commit entry (the old scheduleRender). */
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
    // THE KEYSTROKE LANE (E5, engine-mounted only): a demand raised by a
    // keystroke keeps the plain cadence even while the cost floor holds
    // heavier content back — echo paints ahead of weight.
    const engine = this.engine()
    const inputPriority = engine?.consumeInputPriority() ?? false
    const windowMs = this.windowMs(inputPriority)
    if (now - this.windowOpenedAt >= windowMs) {
      // Leading edge: idle (or the window elapsed) — paint now. SERVE AND
      // ABSORB: a due-but-undelivered trailing timer (the event loop
      // blocked past the boundary — a long React commit) is served by THIS
      // invoke; left armed it would fire a same-instant second paint
      // (audit-t6-slices12 F1 — the class lodash's lastArgs gate prevented).
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
    // Inside the window: arm (or keep) the trailing edge at the boundary.
    // An input-priority demand RE-ARMS an armed trailing edge to the
    // earlier cadence boundary (the floor's later edge must not hold echo).
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

  /** Arm the scroll-drain tick: a plain quarter-interval timeout, never the
   *  throttle (see header). Idempotent while armed. */
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

  /** Entering a render cancels a pending drain — the render underway handles
   *  the drain and re-arms if needed. */
  onRenderEntry(): void {
    if (this.drainTimer !== null) {
      this.clock.clearTimeout(this.drainTimer)
      this.drainTimer = null
    }
  }

  /** Drop every armed edge without invoking (unmount, detach). */
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

  /** Probe-facing state derivation (never drives behavior). */
  state(): SchedulerState {
    if (this.settleHeld) return 'settle-hold'
    if (this.bootTimer !== null) return 'boot-hold'
    if (this.drainTimer !== null) return 'drain-armed'
    if (this.trailingTimer !== null) return 'trailing-armed'
    if (this.clock.now() - this.windowOpenedAt < FRAME_INTERVAL_MS) return 'window-open'
    return 'idle'
  }
}
