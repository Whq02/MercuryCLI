// ============================================================================
//  src/bootstrap/runtime/interaction-clock.ts — the interaction-clock owner
//
//
//  Scope: PROCESS — the deferred last-interaction timestamp. The dirty-bit
//  batching exists so a burst of keypresses costs ONE Date.now(): by default
//  updateLastInteractionTime only sets the bit, and Ink calls
//  flushInteractionTime before each render. `immediate` exists for
//  post-render/useEffect callers where the next render may never come.
//
//  The clock is INJECTED (constructor seam) with a default that reads the
//  global Date.now at call time — never captured by reference, so clock
//  patching in provers (and any future virtual-clock harness) works through
//  the default.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports nothing. src/bootstrap/
//  state.ts is the ONLY sanctioned importer; every consumer goes through the
//  frozen facade.
// ============================================================================

export class InteractionClockOwner {
  private lastInteractionTime: number
  private dirty = false

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastInteractionTime = this.now()
  }

  /**
   * Record an interaction. The default is the dirty-bit path: no clock read
   * now, one Date.now() at the next render flush — a keypress burst costs a
   * single clock call.
   *
   * `immediate` is for callers that run AFTER the render cycle already
   * flushed (React useEffect and friends): for them the deferred stamp
   * would sit stale until a next render that may never come — a permission
   * dialog idling for input renders nothing.
   */
  updateLastInteractionTime(immediate?: boolean): void {
    if (immediate) {
      this.flushInner()
    } else {
      this.dirty = true
    }
  }

  /**
   * Settle the dirty bit: when an interaction was recorded since the last
   * flush, stamp the clock now. Ink calls this before each render cycle —
   * the batching half of the dirty-bit design.
   */
  flushInteractionTime(): void {
    if (this.dirty) {
      this.flushInner()
    }
  }

  private flushInner(): void {
    this.lastInteractionTime = this.now()
    this.dirty = false
  }

  getLastInteractionTime(): number {
    return this.lastInteractionTime
  }
}
