import type { ParsedKey } from '../input/input-decoder.js'
import { TerminalEvent } from './terminal-event.js'
import { notBuilt } from '../../pi/holes.js'

export class KeyboardEvent extends TerminalEvent {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly superKey: boolean
  readonly fn: boolean

  constructor(parsedKey: ParsedKey) {
    notBuilt('src/ink/events/keyboard-event.ts:13')
    super(...(notBuilt('src/ink/events/keyboard-event.ts:13') as ConstructorParameters<typeof TerminalEvent>))
  }
}
