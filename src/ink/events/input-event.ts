// The parsed-key → public key record + text projection, and the monotonic
// input sequence with its route-commit consumption watermark. A surface that
// opens captures the current sequence number and thereafter discards
// anything numbered at or below it: the opening event excludes itself by
// construction, and the first event after it is accepted however soon it
// arrives.

import {
  nonAlphanumericKeys,
  type ParsedKey,
} from '../input/input-decoder.js'
import { Event } from './event.js'

/** The public key record every keybinding in the product reads. */
export type Key = {
  upArrow: boolean
  downArrow: boolean
  leftArrow: boolean
  rightArrow: boolean
  pageDown: boolean
  pageUp: boolean
  wheelUp: boolean
  wheelDown: boolean
  home: boolean
  end: boolean
  return: boolean
  escape: boolean
  ctrl: boolean
  shift: boolean
  fn: boolean
  tab: boolean
  backspace: boolean
  delete: boolean
  meta: boolean
  super: boolean
  isPasted: boolean
}

// Exactly one table drives the named flags; the parsed name sets at most one
// of them. The parsed-name side is contract data shared with the decoder.
const NAME_TO_FLAG: Record<string, keyof Key> = {
  up: 'upArrow',
  down: 'downArrow',
  left: 'leftArrow',
  right: 'rightArrow',
  pagedown: 'pageDown',
  pageup: 'pageUp',
  wheelup: 'wheelUp',
  wheeldown: 'wheelDown',
  home: 'home',
  end: 'end',
  return: 'return',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  delete: 'delete',
}

const FUNCTIONAL_NAMES = new Set<string>(nonAlphanumericKeys)

// The four special sequence families that write their own text (the escape
// prefix has already been stripped when these are tested).
const EXTENDED_KEYBOARD_RE = /^\[\d[\d;:]*u$/
const MODIFY_OTHER_KEYS_RE = /^\[27;[\d;]*~$/
const EVENT_TYPED_FUNCTIONAL_RE = /^\[[\d;]*;\d+:\d+[~A-Za-z]$/
const MOUSE_REPORT_WITHOUT_ESC_RE = /^\[<[\d;]+[Mm]$/

/** Families 1–3 share one normaliser: an absent name is swallowed; `space`
 *  is a literal space; a functional name yields EMPTY (its flag carries the
 *  meaning — an extended-protocol shift+enter must never leak the word for
 *  the return key); a printable single-character name yields itself. */
function normalizeSpecialFamilyText(name: string | undefined): string {
  if (!name) return ''
  if (name === 'space') return ' '
  if (FUNCTIONAL_NAMES.has(name)) return ''
  if (name.length === 1) return name
  return ''
}

function projectKey(parsed: ParsedKey): Key {
  const key: Key = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: parsed.ctrl,
    shift: parsed.shift,
    fn: parsed.fn,
    tab: false,
    backspace: false,
    delete: false,
    // Compatibility rule: escape-prefixed sequences parse with the option
    // modifier, and a bare escape key also reads as meta downstream.
    meta: parsed.meta || parsed.name === 'escape' || parsed.option,
    super: parsed.super,
    isPasted: parsed.isPasted,
  }
  if (parsed.name !== undefined) {
    const flag = NAME_TO_FLAG[parsed.name]
    if (flag) (key as Record<keyof Key, boolean>)[flag] = true
  }
  return key
}

function projectText(parsed: ParsedKey, key: Key): { text: string; key: Key } {
  let text = parsed.ctrl ? (parsed.name ?? '') : (parsed.sequence ?? '')

  // ctrl+space parses with the literal name for space.
  if (parsed.ctrl && parsed.name === 'space') text = ' '

  // A grammar-matched sequence with a code but no table name (higher
  // function keys, right-alternate variants): stripping the escape prefix
  // would leak the remaining bytes into the prompt.
  if (parsed.code !== undefined && parsed.name === undefined) {
    return { text: '', key }
  }

  // The flush-race sink: a nameless fragment shaped like a modern mouse
  // report without its escape prefix.
  if (parsed.name === undefined && MOUSE_REPORT_WITHOUT_ESC_RE.test(text)) {
    return { text: '', key }
  }

  // A still-present escape prefix is stripped.
  while (text.startsWith('\x1b')) text = text.slice(1)

  // Special sequence families write their own text and bypass the
  // functional-name clearing below.
  if (
    EXTENDED_KEYBOARD_RE.test(text) ||
    MODIFY_OTHER_KEYS_RE.test(text) ||
    EVENT_TYPED_FUNCTIONAL_RE.test(text)
  ) {
    text = normalizeSpecialFamilyText(parsed.name)
  } else if (
    text.length === 2 &&
    text.startsWith('O') &&
    parsed.name !== undefined &&
    parsed.name.length === 1
  ) {
    // Application-keypad sequences: the text becomes the name.
    text = parsed.name
  } else if (parsed.name !== undefined && FUNCTIONAL_NAMES.has(parsed.name)) {
    text = ''
  }

  // A single uppercase Latin letter implies shift even when the sequence
  // did not say so.
  if (text.length === 1 && text >= 'A' && text <= 'Z') {
    return { text, key: { ...key, shift: true } }
  }
  return { text, key }
}

let inputEventSeq = 0
let consumedThroughSeq = 0

export class InputEvent extends Event {
  readonly keypress: ParsedKey
  readonly key: Key
  readonly input: string
  readonly seq: number

  constructor(keypress: ParsedKey) {
    super()
    this.keypress = keypress
    const projectedKey = projectKey(keypress)
    const { text, key } = projectText(keypress, projectedKey)
    this.key = key
    this.input = text
    this.seq = ++inputEventSeq
  }
}

/** The most recently constructed event's sequence number; during a
 *  handler's dispatch this equals the dispatching event's number. */
export function currentInputEventSeq(): number {
  return inputEventSeq
}

/** Only the surface-route owner's commit calls this. */
export function markInputConsumedThroughCurrentSeq(): void {
  consumedThroughSeq = inputEventSeq
}

export function inputConsumedThroughSeq(): number {
  return consumedThroughSeq
}

/** A pointer gesture counts as an event for the open-event gate; a gesture
 *  that itself opened a surface stays excluded, since it dispatches under
 *  the number the gate captured at the moment of opening. */
export function bumpInputEventSeqForMouse(): void {
  inputEventSeq++
}
