import { Event } from './event.js'

export type TerminalFocusEventType = 'terminalfocus' | 'terminalblur'

export class TerminalFocusEvent extends Event {
  readonly type: TerminalFocusEventType

  constructor(type: TerminalFocusEventType) {
    super()
    this.type = type
  }
}
