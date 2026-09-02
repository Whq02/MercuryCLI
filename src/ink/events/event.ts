export class Event {
  private halted = false

  didStopImmediatePropagation(): boolean {
    return this.halted
  }

  stopImmediatePropagation(): void {
    this.halted = true
  }
}
