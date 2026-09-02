//  global Date.now at call time — never captured by reference, so clock

export class InteractionClockOwner {
  private lastInteractionTime: number
  private dirty = false

  constructor(private readonly now: () => number = () => Date.now()) {
    this.lastInteractionTime = this.now()
  }

  updateLastInteractionTime(immediate?: boolean): void {
    if (immediate) {
      this.flushInner()
    } else {
      this.dirty = true
    }
  }

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
