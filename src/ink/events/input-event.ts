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
const MOUSE_REPORT_SHAPE_RE = /^(?:\x1b+\[<\d[\d;]*[Mm]?|\[<\d[\d;]*[Mm])$/

function normalizeSpecialFamilyText(name: string | undefined): string {
  if (!name) return ''
  if (name === 'space') return ' '
  if (FUNCTIONAL_NAMES.has(name)) return ''
  return name
}

const SILENT_CSI_HEAD_RE = /^\x1b+\[[?><=]?[\d;:$]*$/
const LEADING_ESC_RE = /^\x1b+/
const ASCII_CAPITAL_RE = /^[A-Z]$/

function projectKey(keypress: ParsedKey, wheelStep: boolean, input: string): Key {
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
    ctrl: keypress.ctrl,
    shift: keypress.shift || ASCII_CAPITAL_RE.test(input),
    fn: keypress.fn,
    tab: false,
    backspace: false,
    delete: false,
    meta: keypress.meta || keypress.name === 'escape' || keypress.option,
    super: keypress.super,
    isPasted: keypress.isPasted,
  }
  if (keypress.name !== undefined && Object.hasOwn(NAME_TO_FLAG, keypress.name)) key[NAME_TO_FLAG[keypress.name]!] = true
  if (wheelStep) {
    key.upArrow = key.wheelUp
    key.downArrow = key.wheelDown
  }
  return key
}

function projectText(keypress: ParsedKey): string {
  const name: string | undefined = keypress.name
  const start: string = (keypress.ctrl ? name : keypress.sequence) ?? ''
  if (keypress.ctrl && name === 'space') return ' '
  if (keypress.code !== undefined && name === undefined) return ''
  if (!name) {
    if (!keypress.isPasted && MOUSE_REPORT_SHAPE_RE.test(start)) return ''
    if (SILENT_CSI_HEAD_RE.test(keypress.sequence ?? '')) return ''
  }
  const text = start.replace(LEADING_ESC_RE, '')
  if (EXTENDED_KEYBOARD_RE.test(text) || MODIFY_OTHER_KEYS_RE.test(text) || EVENT_TYPED_FUNCTIONAL_RE.test(text)) {
    return normalizeSpecialFamilyText(name)
  }
  if (text.length === 2 && text.startsWith('O') && name?.length === 1) return name
  if (name !== undefined && FUNCTIONAL_NAMES.has(name)) return ''
  return text
}

let inputEventSeq = 0
let consumedThroughSeq = 0

export class InputEvent extends Event {
  readonly keypress: ParsedKey
  readonly key: Key
  readonly input: string
  readonly seq: number

  constructor(keypress: ParsedKey, readonly wheelStep: boolean = false) {
    super()
    this.keypress = keypress
    this.input = projectText(keypress)
    this.key = projectKey(keypress, wheelStep, this.input)
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
