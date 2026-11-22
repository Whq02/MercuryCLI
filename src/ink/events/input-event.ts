import {
  nonAlphanumericKeys,
  type ParsedKey,
} from '../input/input-decoder.js'
import { Event } from './event.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type Key = Unbuilt

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

let inputEventSeq = 0
let consumedThroughSeq = 0

export class InputEvent extends Event {
  readonly keypress: ParsedKey
  readonly key: Key
  readonly input: string
  readonly seq: number

  constructor(keypress: ParsedKey, readonly wheelStep?: boolean) {
    notBuilt('src/ink/events/input-event.ts:146')
    super(...(notBuilt('src/ink/events/input-event.ts:146') as ConstructorParameters<typeof Event>))
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
