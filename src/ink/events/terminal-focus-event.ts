import { Event } from './event.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type TerminalFocusEventType = Unbuilt

export class TerminalFocusEvent extends Event {
  readonly type: TerminalFocusEventType

  constructor(type: TerminalFocusEventType) {
    notBuilt('src/ink/events/terminal-focus-event.ts:9')
    super(...(notBuilt('src/ink/events/terminal-focus-event.ts:9') as ConstructorParameters<typeof Event>))
  }
}
