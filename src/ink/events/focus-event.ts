// Focus/blur event with a related target. Bubbles (matching the web
// renderer's focus-in/focus-out semantics so parents can observe descendant
// focus changes) and is NOT cancelable.

import { TerminalEvent, type EventTarget } from './terminal-event.js'

export class FocusEvent extends TerminalEvent {
  override readonly cancelable = false
  readonly relatedTarget: EventTarget | null

  constructor(type: 'focus' | 'blur', relatedTarget?: EventTarget | null) {
    super(type)
    this.relatedTarget = relatedTarget ?? null
  }
}
