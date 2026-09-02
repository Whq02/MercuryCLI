
import type { ParsedKey } from '../input/input-decoder.js'
import { TerminalEvent } from './terminal-event.js'

export class KeyboardEvent extends TerminalEvent {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly superKey: boolean
  readonly fn: boolean

  constructor(parsedKey: ParsedKey) {
    super('keydown')
    this.ctrl = parsedKey.ctrl
    this.shift = parsedKey.shift
    this.meta = parsedKey.meta || parsedKey.option
    this.superKey = parsedKey.super
    this.fn = parsedKey.fn

    const sequence = parsedKey.sequence
    const name = parsedKey.name || undefined
    if (parsedKey.ctrl) {
      this.key = name ?? sequence ?? ''
    } else if (
      sequence !== undefined &&
      sequence.length === 1 &&
      sequence.charCodeAt(0) >= 0x20 &&
      sequence.charCodeAt(0) !== 0x7f
    ) {
      this.key = sequence
    } else {
      this.key = name ?? sequence ?? ''
    }
  }
}
