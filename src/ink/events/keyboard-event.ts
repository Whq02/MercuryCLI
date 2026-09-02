// DOM-shaped keyboard event over a parsed key. The `key` projection follows
// browser semantics: with control held it is the parsed NAME (a browser
// reports the letter, not the control byte); a single code unit at or above
// space (and not DEL) is the literal character; otherwise the parsed name,
// falling back to the sequence. The idiomatic printable check is therefore a
// length-1 `key`.
//
// An EMPTY parsed name carries no information and never wins the fallback:
// batched printable chunks (fast typing, unbracketed paste fragments) parse
// through the decoder's nameless base key — `name: ''`, the text in
// `sequence` — and an empty string is not nullish, so `name ?? sequence`
// projected `key: ''` and every DOM-channel consumer dropped the whole
// batch (the Q5 keytrace find; their search field re-keyed from the legacy
// channel as a workaround).

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
