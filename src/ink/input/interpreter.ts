import { extendedKeysSupportedNow } from '../session/capabilities.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export type ParsedKey = Unbuilt

export const DECRPM_STATUS: Unbuilt = unbuilt('src/ink/input/interpreter.ts:22')

export type TerminalResponse =
  Unbuilt

export type ParsedResponse = Unbuilt

export type ParsedMouse = Unbuilt

export type ParsedInput = Unbuilt

export function openPlainCursorWindow(rows: readonly number[], until: number): () => void {
  return notBuilt('src/ink/input/interpreter.ts:65')
}

export function interpretResponse(s: string): TerminalResponse | null {
  return notBuilt('src/ink/input/interpreter.ts:78')
}

export function interpretMouse(s: string): ParsedMouse | null {
  return notBuilt('src/ink/input/interpreter.ts:119')
}


const KEY_NAME: Record<string, string> = {
  OP: 'f1', OQ: 'f2', OR: 'f3', OS: 'f4',
  Op: '0', Oq: '1', Or: '2', Os: '3', Ot: '4',
  Ou: '5', Ov: '6', Ow: '7', Ox: '8', Oy: '9',
  Oj: '*', Ok: '+', Ol: ',', Om: '-', On: '.', Oo: '/',
  OM: 'return',
  '[11~': 'f1', '[12~': 'f2', '[13~': 'f3', '[14~': 'f4',
  '[[A': 'f1', '[[B': 'f2', '[[C': 'f3', '[[D': 'f4', '[[E': 'f5',
  '[15~': 'f5', '[17~': 'f6', '[18~': 'f7', '[19~': 'f8',
  '[20~': 'f9', '[21~': 'f10', '[23~': 'f11', '[24~': 'f12',
  '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left',
  '[E': 'clear', '[F': 'end', '[H': 'home',
  '[Q': 'f2', '[S': 'f4',
  OA: 'up', OB: 'down', OC: 'right', OD: 'left',
  OE: 'clear', OF: 'end', OH: 'home',
  '[1~': 'home', '[2~': 'insert', '[3~': 'delete',
  '[4~': 'end', '[5~': 'pageup', '[6~': 'pagedown',
  '[[5~': 'pageup', '[[6~': 'pagedown',
  '[7~': 'home', '[8~': 'end',
  '[a': 'up', '[b': 'down', '[c': 'right', '[d': 'left', '[e': 'clear',
  '[2$': 'insert', '[3$': 'delete', '[5$': 'pageup',
  '[6$': 'pagedown', '[7$': 'home', '[8$': 'end',
  Oa: 'up', Ob: 'down', Oc: 'right', Od: 'left', Oe: 'clear',
  '[2^': 'insert', '[3^': 'delete', '[5^': 'pageup',
  '[6^': 'pagedown', '[7^': 'home', '[8^': 'end',
  '[Z': 'tab',
}

const LITERAL_KEYS: Record<string, Partial<ParsedKey>> = {
  '\r': { name: 'return', raw: undefined },
  '\n': { name: 'enter' },
  '\t': { name: 'tab' },
  '\b': { name: 'backspace' },
  '\x7f': { name: 'backspace' },
  '\x1b\b': { name: 'backspace', meta: true },
  '\x1b\x7f': { name: 'backspace', meta: true },
  '\x1b': { name: 'escape' },
  '\x1b\x1b': { name: 'escape', meta: true },
  ' ': { name: 'space' },
  '\x1b ': { name: 'space', meta: true },
  '\x1f': { name: '_', ctrl: true },
}

const CSI_P = '[P'

function csiPName(): string {
  return extendedKeysSupportedNow() ? 'f1' : 'delete'
}

const SHIFT_CODES = new Set([
  '[a', '[b', '[c', '[d', '[e',
  '[2$', '[3$', '[5$', '[6$', '[7$', '[8$', '[Z',
])
const CTRL_CODES = new Set([
  'Oa', 'Ob', 'Oc', 'Od', 'Oe',
  '[2^', '[3^', '[5^', '[6^', '[7^', '[8^',
])

export const nonAlphanumericKeys = [
  ...Object.values(KEY_NAME).filter(v => v.length > 1),
  'escape',
  'backspace',
  'wheelup',
  'wheeldown',
  'mouse',
]

const KEYPAD_FIRST_CODE = 57399
const NAMED_KEYCODES: ReadonlyMap<number, string> = new Map<number, string>([
  [9, 'tab'],
  [13, 'return'],
  [27, 'escape'],
  [32, 'space'],
  [127, 'backspace'],
  ...[...'0123456789./*-+'].map((name, offset): [number, string] => [KEYPAD_FIRST_CODE + offset, name]),
  [57414, 'return'],
  [57415, '='],
])

function isTypedCodepoint(codepoint: number): boolean {
  if (!Number.isFinite(codepoint) || codepoint < 0x20 || codepoint === 0x7f || codepoint > 0x10ffff) return false
  return !(codepoint >= 0xe000 && codepoint <= 0xf8ff)
}

function keycodeToName(keycode: number, plane: 'chord' | 'typed' = 'chord'): string | undefined {
  const named = NAMED_KEYCODES.get(keycode)
  if (named !== undefined) return named
  if (keycode >= 32 && keycode <= 126) return String.fromCharCode(keycode).toLowerCase()
  return plane === 'typed' && isTypedCodepoint(keycode) ? String.fromCodePoint(keycode) : undefined
}

function resolveChordNameFromLayout(
  base: string | undefined,
  shifted: string | undefined,
): string | undefined {
  for (const field of [base, shifted]) {
    if (!field) continue
    const name = keycodeToName(parseInt(field, 10))
    if (name !== undefined) return name
  }
  return undefined
}


const CSI_U_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d*))?(?::\d*)*(?:;(\d+)(?::(\d+))?)?(?:;([\d:]+))?u$/
const EVENT_TYPED_FUNCTIONAL_RE = /^(\x1b\[[\d;]*);(\d+):(\d+)([~A-Za-z])$/

function navKey(s: string, name: string, ctrl: boolean): ParsedKey {
  return {
    kind: 'key',
    name,
    ctrl,
    meta: false,
    shift: false,
    option: false,
    super: false,
    fn: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }
}

export function createPasteKey(content: string): ParsedKey {
  return notBuilt('src/ink/input/interpreter.ts:305')
}

export function interpretKey(s?: string): ParsedKey {
  return notBuilt('src/ink/input/interpreter.ts:310')
}


const ORPHAN_MOUSE_PROBE_RE =
  /^\[(?:<\d+;\d+;\d+[Mm]|M[\x20-\x7f][\x20-￿]{2})|(?<!\d)\d+;\d+;\d+[Mm]/
const ORPHAN_MOUSE_EVENT_RE =
  /\[<\d+;\d+;\d+[Mm]|\[M[\x20-\x7f][\x20-￿]{2}|\[?<?\d+;\d+;\d+[Mm]/g
const MOUSE_FRAGMENT_RE = /^<?\d*(?:;\d*){0,2}[Mm]?$/

export function hasOrphanMouseBytes(text: string): boolean {
  return ORPHAN_MOUSE_PROBE_RE.test(text)
}

export function extractOrphanMouseEvents(text: string, out: ParsedInput[]): void {
  const emitText = (chunk: string): void => {
    if (!chunk) return
    if (MOUSE_FRAGMENT_RE.test(chunk)) return
    out.push(interpretKey(chunk))
  }
  ORPHAN_MOUSE_EVENT_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = ORPHAN_MOUSE_EVENT_RE.exec(text)) !== null) {
    if (m.index > last) emitText(text.slice(last, m.index))
    last = m.index + m[0].length
    if (ORPHAN_MOUSE_EVENT_RE.lastIndex <= m.index) {
      ORPHAN_MOUSE_EVENT_RE.lastIndex = m.index + 1
    }
    if (m[0][0] !== '[') continue
    const resynthesized = '\x1b' + m[0]
    const mouse = interpretMouse(resynthesized)
    if (mouse) out.push(mouse)
    else out.push(interpretKey(resynthesized))
  }
  if (last < text.length) emitText(text.slice(last))
}
