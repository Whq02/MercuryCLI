// The PROPAGATING event base: the DOM-shaped surface the dispatcher drives
// (keyboard, focus, paste, resize). The click/input/terminal-focus events
// deliberately do NOT extend this — they ride the minimal base and their
// only propagation control is stop-immediate-propagation.

import { Event } from './event.js'

export type EventTarget = {
  parentNode: EventTarget | undefined
  _eventHandlers?: Record<string, unknown>
}

export type EventPhase = 'none' | 'capturing' | 'at_target' | 'bubbling'

export class TerminalEvent extends Event {
  readonly type: string
  readonly timeStamp: number
  readonly bubbles: boolean = true
  readonly cancelable: boolean = true
  target: EventTarget | null = null
  currentTarget: EventTarget | null = null
  eventPhase: EventPhase = 'none'
  defaultPrevented = false

  private _propagationStopped = false

  constructor(type: string) {
    super()
    this.type = type
    this.timeStamp = performance.now()
  }

  stopPropagation(): void {
    this._propagationStopped = true
  }

  override stopImmediatePropagation(): void {
    super.stopImmediatePropagation()
    this._propagationStopped = true
  }

  preventDefault(): void {
    if (!this.cancelable) return
    this.defaultPrevented = true
  }

  /** Dispatcher-internal reader. */
  isPropagationStopped(): boolean {
    return this._propagationStopped
  }

  /** Dispatcher-internal reader; delegates to the minimal base. */
  isImmediatePropagationStopped(): boolean {
    return this.didStopImmediatePropagation()
  }

  /** Per-node preparation hook, a no-op by default; subclasses needing
   *  per-node setup override it. */
  prepareForNode(_node: EventTarget): void {}
}
