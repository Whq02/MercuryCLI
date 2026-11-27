import { extendedKeysSupportedNow } from '../terminal-session/capabilities.js'


export type ParsedKey = {
  kind: 'key'
  name: string | undefined
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  fn: boolean
  sequence: string | undefined
  raw: string | undefined
  isPasted: boolean
  code?: string
  x?: number
  y?: number
}

export const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const

export type TerminalResponse =
  | { type: 'osc'; code: number; data: string }
  | { type: 'xtversion'; name: string }
  | { type: 'decrqss'; setting: string }
  | { type: 'da1'; params: number[] }
  | { type: 'da2'; params: number[] }
  | { type: 'kittyKeyboard'; flags: number }
  | { type: 'decrpm'; mode: number; status: number }
  | { type: 'cursorPosition'; row: number; col: number }

export type ParsedResponse = {
  kind: 'response'
  sequence: string
  response: TerminalResponse
}

export type ParsedMouse = {
  kind: 'mouse'
  action: 'press' | 'release'
  button: number
  col: number
  row: number
  sequence: string
}

export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse

type PlainCursorWindow = {
  rows: ReadonlySet<number>
  until: number
}

const cursorWindows = new Set<PlainCursorWindow>()

export function openPlainCursorWindow(rows: readonly number[], until: number): () => void {
  const entry: PlainCursorWindow = { rows: new Set(rows), until }
  cursorWindows.add(entry)
  return () => {
    cursorWindows.delete(entry)
  }
}

const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/
const DA1_RE = /^\x1b\[\?([\d;]*)c$/
const DA2_RE = /^\x1b\[>([\d;]*)c$/
const KITTY_KB_RE = /^\x1b\[\?(\d+)u$/
const PRIVATE_CPR_RE = /^\x1b\[\?(\d+);(\d+)R$/
const PLAIN_CPR_RE = /^\x1b\[(\d+);(\d+)R$/
const OSC_RE = /^\x1b\](\d+);([\s\S]*)(?:\x07|\x1b\\)$/
const XTVERSION_RE = /^\x1bP>\|([\s\S]*)(?:\x07|\x1b\\)$/
const DECRQSS_RE = /^\x1bP[01](?:\$r([\s\S]*))?(?:\x07|\x1b\\)$/
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/
const META_CHAR_RE = /^\x1b([a-zA-Z0-9\]\\_^])$/
const FN_KEY_RE = /^\x1b+(\[\[|\[|O|N)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d*)([a-zA-Z]))/

function parseParams(raw: string): number[] {
  if (raw === '') return []
  return raw.split(';').map(part => parseInt(part, 10))
}

export function interpretResponse(s: string): TerminalResponse | null {
  if (s.startsWith('\x1b[')) {
    let m = DECRPM_RE.exec(s)
    if (m) return { type: 'decrpm', mode: parseInt(m[1]!, 10), status: parseInt(m[2]!, 10) }

    m = DA1_RE.exec(s)
    if (m) return { type: 'da1', params: parseParams(m[1]!) }

    m = DA2_RE.exec(s)
    if (m) return { type: 'da2', params: parseParams(m[1]!) }

    m = KITTY_KB_RE.exec(s)
    if (m) return { type: 'kittyKeyboard', flags: parseInt(m[1]!, 10) }

    m = PRIVATE_CPR_RE.exec(s)
    if (m) return { type: 'cursorPosition', row: parseInt(m[1]!, 10), col: parseInt(m[2]!, 10) }

    m = PLAIN_CPR_RE.exec(s)
    if (m) {
      const row = parseInt(m[1]!, 10)
      const col = parseInt(m[2]!, 10)
      const now = performance.now()
      for (const win of cursorWindows) {
        if (now >= win.until) {
          cursorWindows.delete(win)
          continue
        }
        if (win.rows.has(row) && Number.isSafeInteger(col) && col > 0) {
          return { type: 'cursorPosition', row, col }
        }
      }
      return null
    }

    return null
  }

  let m = OSC_RE.exec(s)
  if (m) return { type: 'osc', code: parseInt(m[1]!, 10), data: m[2]! }

  m = XTVERSION_RE.exec(s)
  if (m) return { type: 'xtversion', name: m[1]! }

  m = DECRQSS_RE.exec(s)
  if (m) return { type: 'decrqss', setting: m[1] ?? '' }

  return null
}

export function interpretMouse(s: string): ParsedMouse | null {
  const m = SGR_MOUSE_RE.exec(s)
  if (!m) return null
  const button = parseInt(m[1]!, 10)
  if ((button & 64) !== 0) return null
  return {
    kind: 'mouse',
    button,
    action: m[4] === 'M' ? 'press' : 'release',
    col: parseInt(m[2]!, 10),
    row: parseInt(m[3]!, 10),
    sequence: s,
  }
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

function defaultKey(s: string): ParsedKey {
  return {
    kind: 'key',
    name: '',
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: s,
    raw: s,
    isPasted: false,
  }
}

function applyModifier(key: ParsedKey, modifier: number): void {
  const bits = modifier - 1
  key.shift = Boolean(bits & 1)
  key.meta = Boolean(bits & 2)
  key.ctrl = Boolean(bits & 4)
  key.super = Boolean(bits & 8)
}

function keyWithModifiers(s: string, name: string | undefined, modifier: number): ParsedKey {
  const key = defaultKey(s)
  key.name = name
  applyModifier(key, modifier)
  return key
}

function mouseKey(s: string, button: number, col: number, row: number): ParsedKey {
  const bits = button & (64 | 2 | 1)
  if (bits === 64) {
    const key = navKey(s, 'wheelup', false)
    key.x = col
    key.y = row
    return key
  }
  if (bits === 65) {
    const key = navKey(s, 'wheeldown', false)
    key.x = col
    key.y = row
    return key
  }
  return navKey(s, 'mouse', false)
}

export function createPasteKey(content: string): ParsedKey {
  const key = defaultKey(content)
  key.isPasted = true
  return key
}

export function interpretKey(s: string = ''): ParsedKey {
  if (PLAIN_CPR_RE.test(s) && !s.startsWith('\x1b[1;')) {
    const key = defaultKey(s)
    key.name = undefined
    key.code = '[R'
    return key
  }

  const csiU = CSI_U_RE.exec(s)
  if (csiU) {
    const eventType = csiU[5] ? parseInt(csiU[5], 10) : 1
    if (eventType === 3) return defaultKey(s)

    const modifier = csiU[4] ? parseInt(csiU[4], 10) : 1
    const bits = modifier - 1
    const shift = Boolean(bits & 1)
    const meta = Boolean(bits & 2)
    const ctrl = Boolean(bits & 4)
    const superKey = Boolean(bits & 8)
    const hasChordMod = ctrl || meta || superKey

    let name = keycodeToName(parseInt(csiU[1]!, 10), hasChordMod ? 'chord' : 'typed')
    if (name === undefined && hasChordMod) {
      name = resolveChordNameFromLayout(csiU[3], csiU[2])
    }

    const shifted = csiU[2]
    const textField = csiU[6]
    if (shifted && shift && !hasChordMod && !textField) {
      const shiftedCode = parseInt(shifted, 10)
      if (isTypedCodepoint(shiftedCode)) {
        name = String.fromCodePoint(shiftedCode)
      }
    }

    if (textField && !ctrl && !meta) {
      const parts = textField.split(':')
      let text = ''
      for (const part of parts) {
        if (part === '') return defaultKey(s)
        const cp = Number(part)
        if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return defaultKey(s)
        text += String.fromCodePoint(cp)
      }
      if (text.length > 0) name = text
    }

    return keyWithModifiers(s, name, modifier)
  }

  const eventTyped = EVENT_TYPED_FUNCTIONAL_RE.exec(s)
  if (eventTyped) {
    const eventType = parseInt(eventTyped[3]!, 10)
    if (eventType === 3) return defaultKey(s)
    return interpretKey(`${eventTyped[1]};${eventTyped[2]}${eventTyped[4]}`)
  }

  const mok = MODIFY_OTHER_KEYS_RE.exec(s)
  if (mok) {
    const modifier = parseInt(mok[1]!, 10)
    const codepoint = parseInt(mok[2]!, 10)
    const bits = modifier - 1
    const hasChordMod = Boolean(bits & 2) || Boolean(bits & 4) || Boolean(bits & 8)
    const name = keycodeToName(codepoint, hasChordMod ? 'chord' : 'typed')
    return keyWithModifiers(s, name, modifier)
  }

  const sgrMouse = SGR_MOUSE_RE.exec(s)
  if (sgrMouse) {
    return mouseKey(
      s,
      parseInt(sgrMouse[1]!, 10),
      parseInt(sgrMouse[2]!, 10),
      parseInt(sgrMouse[3]!, 10),
    )
  }

  if (s.length === 6 && s.startsWith('\x1b[M')) {
    return mouseKey(
      s,
      s.charCodeAt(3) - 32,
      s.charCodeAt(4) - 32,
      s.charCodeAt(5) - 32,
    )
  }

  const key = defaultKey(s)

  if (Object.hasOwn(LITERAL_KEYS, s)) {
    Object.assign(key, LITERAL_KEYS[s])
  } else if (s.length === 1) {
    const ch = s.charCodeAt(0)
    if (ch <= 0x1a) {
      key.name = String.fromCharCode(ch + 0x60)
      key.ctrl = true
    } else if (ch >= 0x30 && ch <= 0x39) {
      key.name = 'number'
    } else if (ch >= 0x41 && ch <= 0x5a) {
      key.name = s.toLowerCase()
      key.shift = true
    } else if (ch >= 0x61 && ch <= 0x7a) {
      key.name = s
    }
  } else {
    const metaChar = META_CHAR_RE.exec(s)
    if (metaChar) {
      key.meta = true
      const ch = metaChar[1]!.charCodeAt(0)
      if (ch >= 0x41 && ch <= 0x5a) key.shift = true
    } else {
      const fnMatch = FN_KEY_RE.exec(s)
      if (fnMatch) {
        if (s.startsWith('\x1b\x1b')) key.option = true
        const introducer = fnMatch[1]!
        const code =
          fnMatch[2] !== undefined
            ? `${introducer}${fnMatch[2]}${fnMatch[4]!}`
            : `${introducer}${fnMatch[6]!}`
        const modStr = fnMatch[2] !== undefined ? fnMatch[3] : fnMatch[5]
        const modifier = modStr ? parseInt(modStr, 10) : 1
        applyModifier(key, modifier)
        key.code = code
        key.name =
          code === CSI_P
            ? csiPName()
            : Object.hasOwn(KEY_NAME, code)
              ? KEY_NAME[code]
              : undefined
        if (SHIFT_CODES.has(code)) key.shift = true
        if (CTRL_CODES.has(code)) key.ctrl = true
      }
    }
  }

  if (key.raw === '\x1bb') {
    key.meta = true
    key.name = 'left'
  } else if (key.raw === '\x1bf') {
    key.meta = true
    key.name = 'right'
  }

  switch (s) {
    case '\x1b[1~':
      return navKey(s, 'home', false)
    case '\x1b[4~':
      return navKey(s, 'end', false)
    case '\x1b[5~':
      return navKey(s, 'pageup', false)
    case '\x1b[6~':
      return navKey(s, 'pagedown', false)
    case '\x1b[1;5D':
      return navKey(s, 'left', true)
    case '\x1b[1;5C':
      return navKey(s, 'right', true)
    default:
      return key
  }
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
