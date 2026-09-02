// ============================================================================
//  src/bootstrap/runtime/scroll-gate.ts — the scroll-drain gate owner
//
//
//  Scope: PROCESS, deliberately NOT reset by resetStateForTests — the
//  characterized behavior the contract net pins (prove-state-contract
//  CHARACTERIZED-GAP 2): the drain flag self-clears ONLY via the live
//  debounce timer. The facade holds this owner as a `const` singleton
//  outside the instance-rebuild reset; the cut sequence authorized
//  flipping only GAP 1 (the assistant-default memo), so this gap is preserved as
//  current truth.
//
//  Purpose: scroll frames own the event loop while they drain. Background
//  intervals ask getIsScrollDraining() first and stand down; ScrollBox's
//  scrollBy/scrollTo raise the flag, and it self-clears SCROLL_DRAIN_IDLE_MS
//  after the last scroll event.
//
//  Timers are INJECTED (constructor seam) with defaults that read the global
//  setTimeout/clearTimeout at call time — never captured by reference, so
//  fake-timer patching in provers works through the defaults, and the raw
//  timer handle (with its unref discipline) is preserved.
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports nothing. src/bootstrap/
//  state.ts is the ONLY sanctioned importer; every consumer goes through the
//  frozen facade.
// ============================================================================

const SCROLL_DRAIN_IDLE_MS = 150

type ScrollTimers = {
  set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (handle: ReturnType<typeof setTimeout>) => void
}

// Defaults defer to the GLOBALS at call time (dynamic lookup, not a captured
// reference) — see the header.
const defaultTimers: ScrollTimers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: handle => clearTimeout(handle),
}

export class ScrollGateOwner {
  private draining = false
  private drainTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly timers: ScrollTimers = defaultTimers) {}

  /** A scroll event just landed: raise the drain flag and (re)start the
   *  debounce. While it holds, background intervals stand down. */
  markScrollActivity(): void {
    this.draining = true
    if (this.drainTimer) this.timers.clear(this.drainTimer)
    this.drainTimer = this.timers.set(() => {
      this.draining = false
      this.drainTimer = undefined
    }, SCROLL_DRAIN_IDLE_MS)
    this.drainTimer.unref?.()
  }

  /** True inside the drain window (SCROLL_DRAIN_IDLE_MS after the last
   *  event). An interval that sees true early-returns; its work runs on the
   *  first tick after scroll settles. */
  getIsScrollDraining(): boolean {
    return this.draining
  }

  /** Await this before expensive one-shot work (network, subprocess) that
   *  could coincide with scroll. Resolves immediately if not scrolling;
   *  otherwise polls at the idle interval until the flag clears. */
  async waitForScrollIdle(): Promise<void> {
    while (this.draining) {
      await new Promise(r => this.timers.set(r as () => void, SCROLL_DRAIN_IDLE_MS).unref?.())
    }
  }
}
