
import { TerminalEvent, type EventTarget } from './terminal-event.js'

export class FocusEvent extends TerminalEvent {
  override readonly cancelable = false
  readonly relatedTarget: EventTarget | null

  constructor(type: 'focus' | 'blur', relatedTarget?: EventTarget | null) {
    super(type)
    this.relatedTarget = relatedTarget ?? null
  }
}
