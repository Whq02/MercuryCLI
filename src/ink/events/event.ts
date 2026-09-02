// The propagation-control primitive for the ink event tree. Every dispatch
// hands its handlers one shared Event; a handler that calls
// stopImmediatePropagation() latches the flag, and the dispatcher polls the
// latch between handlers so later listeners on the same walk never fire.
// One-way by construction — a fresh dispatch builds a fresh Event, so there
// is deliberately no reset.
export class Event {
  private halted = false

  didStopImmediatePropagation(): boolean {
    return this.halted
  }

  stopImmediatePropagation(): void {
    this.halted = true
  }
}
