// Terminal window focus/blur, driven by the terminal's focus-reporting mode.
// Rides the MINIMAL base and travels through the emitter only.

import { Event } from './event.js'

export type TerminalFocusEventType = 'terminalfocus' | 'terminalblur'

export class TerminalFocusEvent extends Event {
  readonly type: TerminalFocusEventType

  constructor(type: TerminalFocusEventType) {
    super()
    this.type = type
  }
}
