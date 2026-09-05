
import {
  nonAlphanumericKeys,
  type ParsedKey,
} from '../input/input-decoder.js'
import { Event } from './event.js'

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

const EXTENDED_KEYBOARD_RE = /^\[\d[\d;:]*u$/
const MODIFY_OTHER_KEYS_RE = /^\[27;[\d;]*~$/
const EVENT_TYPED_FUNCTIONAL_RE = /^\[[\d;]*;\d+:\d+[~A-Za-z]$/
const MOUSE_REPORT_WITHOUT_ESC_RE = /^\[<[\d;]+[Mm]$/

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

  if (parsed.ctrl && parsed.name === 'space') text = ' '

  if (parsed.code !== undefined && parsed.name === undefined) {
    return { text: '', key }
  }

  if (parsed.name === undefined && MOUSE_REPORT_WITHOUT_ESC_RE.test(text)) {
    return { text: '', key }
  }

  if (!parsed.name && /^\x1b\[[\d;:]*$/.test(parsed.sequence ?? '')) {
    return { text: '', key }
  }

  while (text.startsWith('\x1b')) text = text.slice(1)

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
    text = parsed.name
  } else if (parsed.name !== undefined && FUNCTIONAL_NAMES.has(parsed.name)) {
    text = ''
  }

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

export function currentInputEventSeq(): number {
  return inputEventSeq
}

export function markInputConsumedThroughCurrentSeq(): void {
  consumedThroughSeq = inputEventSeq
}

export function inputConsumedThroughSeq(): number {
  return consumedThroughSeq
}

export function bumpInputEventSeqForMouse(): void {
  inputEventSeq++
}
