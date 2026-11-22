import type { ParsedKey } from '../input/input-decoder.js'
import { TerminalEvent } from './terminal-event.js'

function keyText(parsedKey: ParsedKey): string {
  const { name, sequence } = parsedKey
  if (!parsedKey.ctrl && sequence?.length === 1) {
    const unit = sequence.charCodeAt(0)
    if (unit >= 0x20 && unit !== 0x7f) return sequence
  }
  return name || sequence || ''
}

export class KeyboardEvent extends TerminalEvent {
  readonly key: string
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
  readonly superKey: boolean
  readonly fn: boolean

  constructor(parsedKey: ParsedKey) {
    super('keydown')
    this.key = keyText(parsedKey)
    this.ctrl = parsedKey.ctrl
    this.shift = parsedKey.shift
    this.meta = parsedKey.meta || parsedKey.option
    this.superKey = parsedKey.super
    this.fn = parsedKey.fn
  }
}
