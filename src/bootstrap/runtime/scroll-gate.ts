
const SCROLL_DRAIN_IDLE_MS = 150

type ScrollTimers = {
  set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clear: (handle: ReturnType<typeof setTimeout>) => void
}

const defaultTimers: ScrollTimers = {
  set: (cb, ms) => setTimeout(cb, ms),
  clear: handle => clearTimeout(handle),
}

export class ScrollGateOwner {
  private draining = false
  private drainTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly timers: ScrollTimers = defaultTimers) {}

  markScrollActivity(): void {
    this.draining = true
    if (this.drainTimer) this.timers.clear(this.drainTimer)
    this.drainTimer = this.timers.set(() => {
      this.draining = false
      this.drainTimer = undefined
    }, SCROLL_DRAIN_IDLE_MS)
    this.drainTimer.unref?.()
  }

  getIsScrollDraining(): boolean {
    return this.draining
  }

  async waitForScrollIdle(): Promise<void> {
    while (this.draining) {
      await new Promise(r => this.timers.set(r as () => void, SCROLL_DRAIN_IDLE_MS).unref?.())
    }
  }
}
