// ============================================================================
//  interpreter — Mercury input tokens → typed input atoms.
//
//  RESPONSIBILITY: one scanned token → one atom: a terminal RESPONSE (answers
//  to queries we sent), a MOUSE event (clicks/drags/releases — wheel stays a
//  key for the keybinding system), or a KEYPRESS. The lookup tables are the
//  public terminal vocabulary (xterm/rxvt/putty/Cygwin/SS3/kitty); the
//  interpretation ORDER is part of the pinned contract (CSI-u before
//  modifyOtherKeys before the legacy FN grammar; the nav overrides last).
//
//  CONTRACT: the B3 keypress corpus goldens (byte-exact ParsedKey objects) +
//  prove-input-contract (response disambiguation · mouse encodings · wheel
//  bursts · orphan extraction · key projection).
// ============================================================================

// ── the atom vocabulary (the public contract) ───────────────────────────────

export type ParsedKey = {
  kind: 'key'
  fn: boolean
  name: string | undefined
  ctrl: boolean
  meta: boolean
  shift: boolean
  option: boolean
  super: boolean
  sequence: string | undefined
  raw: string | undefined
  code?: string
  isPasted: boolean
  /** Wheel events only (SGR/X10 carry the pointer cell): 1-based terminal
   *  column/row under the pointer at the notch — the wheel-under-pointer
   *  routing seam. Absent on every other key. */
  x?: number
  y?: number
}

/** DECRPM status values (response to DECRQM). */
export const DECRPM_STATUS = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const

/** A response sequence received FROM the terminal (never a keypress). */
export type TerminalResponse =
  | { type: 'decrpm'; mode: number; status: number }
  | { type: 'da1'; params: number[] }
  | { type: 'da2'; params: number[] }
  | { type: 'kittyKeyboard'; flags: number }
  | { type: 'cursorPosition'; row: number; col: number }
  | { type: 'osc'; code: number; data: string }
  | { type: 'xtversion'; name: string }

export type ParsedResponse = {
  kind: 'response'
  sequence: string
  response: TerminalResponse
}

/** SGR mouse event with coordinates (wheel events remain ParsedKey). */
export type ParsedMouse = {
  kind: 'mouse'
  /** Raw SGR button code: low 2 bits = button, 0x20 = drag/motion, 0x40 = wheel. */
  button: number
  action: 'press' | 'release'
  col: number
  row: number
  sequence: string
}

export type ParsedInput = ParsedKey | ParsedMouse | ParsedResponse

// ── responses ───────────────────────────────────────────────────────────────
// Every pattern is syntactically unreachable by a physical key — the `?`/`>`
// markers are load-bearing (plain `CSI 1;2R` is Shift+F3; `CSI 25u` is a
// CSI-u key).

const DECRPM_RE = /^\x1b\[\?(\d+);(\d+)\$y$/
const DA1_RE = /^\x1b\[\?([\d;]*)c$/
const DA2_RE = /^\x1b\[>([\d;]*)c$/
const KITTY_FLAGS_RE = /^\x1b\[\?(\d+)u$/
const CURSOR_POSITION_RE = /^\x1b\[\?(\d+);(\d+)R$/
const OSC_RESPONSE_RE = /^\x1b\](\d+);(.*?)(?:\x07|\x1b\\)$/s
const XTVERSION_RE = /^\x1bP>\|(.*?)(?:\x07|\x1b\\)$/s

function numericParams(params: string): number[] {
  if (!params) return []
  return params.split(';').map(p => parseInt(p, 10))
}

/** Recognize a sequence as a terminal response, or null ⇒ treat as a key. */
export function interpretResponse(s: string): TerminalResponse | null {
  if (s.startsWith('\x1b[')) {
    let m: RegExpExecArray | null
    if ((m = DECRPM_RE.exec(s))) {
      return { type: 'decrpm', mode: parseInt(m[1]!, 10), status: parseInt(m[2]!, 10) }
    }
    if ((m = DA1_RE.exec(s))) return { type: 'da1', params: numericParams(m[1]!) }
    if ((m = DA2_RE.exec(s))) return { type: 'da2', params: numericParams(m[1]!) }
    if ((m = KITTY_FLAGS_RE.exec(s))) {
      return { type: 'kittyKeyboard', flags: parseInt(m[1]!, 10) }
    }
    if ((m = CURSOR_POSITION_RE.exec(s))) {
      return { type: 'cursorPosition', row: parseInt(m[1]!, 10), col: parseInt(m[2]!, 10) }
    }
    return null
  }
  if (s.startsWith('\x1b]')) {
    const m = OSC_RESPONSE_RE.exec(s)
    if (m) return { type: 'osc', code: parseInt(m[1]!, 10), data: m[2]! }
  }
  if (s.startsWith('\x1bP')) {
    const m = XTVERSION_RE.exec(s)
    if (m) return { type: 'xtversion', name: m[1]! }
  }
  return null
}

// ── mouse ───────────────────────────────────────────────────────────────────

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

/** SGR click/drag/release → ParsedMouse; wheel (bit 0x40) → null (the wheel
 *  stays a ParsedKey so keybindings route it to scroll). */
export function interpretMouse(s: string): ParsedMouse | null {
  const m = SGR_MOUSE_RE.exec(s)
  if (!m) return null
  const button = parseInt(m[1]!, 10)
  if ((button & 0x40) !== 0) return null
  return {
    kind: 'mouse',
    button,
    action: m[4] === 'M' ? 'press' : 'release',
    col: parseInt(m[2]!, 10),
    row: parseInt(m[3]!, 10),
    sequence: s,
  }
}

// ── the key vocabulary tables (public terminal formats) ─────────────────────

const KEY_NAME: Record<string, string> = {
  /* xterm/gnome ESC O letter */
  OP: 'f1', OQ: 'f2', OR: 'f3', OS: 'f4',
  /* application keypad digits */
  Op: '0', Oq: '1', Or: '2', Os: '3', Ot: '4',
  Ou: '5', Ov: '6', Ow: '7', Ox: '8', Oy: '9',
  /* application keypad operators */
  Oj: '*', Ok: '+', Ol: ',', Om: '-', On: '.', Oo: '/',
  OM: 'return',
  /* xterm/rxvt ESC [ number ~ */
  '[11~': 'f1', '[12~': 'f2', '[13~': 'f3', '[14~': 'f4',
  /* Cygwin/libuv */
  '[[A': 'f1', '[[B': 'f2', '[[C': 'f3', '[[D': 'f4', '[[E': 'f5',
  /* common */
  '[15~': 'f5', '[17~': 'f6', '[18~': 'f7', '[19~': 'f8',
  '[20~': 'f9', '[21~': 'f10', '[23~': 'f11', '[24~': 'f12',
  /* xterm ESC [ letter */
  '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left',
  '[E': 'clear', '[F': 'end', '[H': 'home',
  /* xterm/gnome ESC O letter */
  OA: 'up', OB: 'down', OC: 'right', OD: 'left',
  OE: 'clear', OF: 'end', OH: 'home',
  /* xterm/rxvt ESC [ number ~ */
  '[1~': 'home', '[2~': 'insert', '[3~': 'delete',
  '[4~': 'end', '[5~': 'pageup', '[6~': 'pagedown',
  /* putty */
  '[[5~': 'pageup', '[[6~': 'pagedown',
  /* rxvt */
  '[7~': 'home', '[8~': 'end',
  /* rxvt with modifiers */
  '[a': 'up', '[b': 'down', '[c': 'right', '[d': 'left', '[e': 'clear',
  '[2$': 'insert', '[3$': 'delete', '[5$': 'pageup',
  '[6$': 'pagedown', '[7$': 'home', '[8$': 'end',
  Oa: 'up', Ob: 'down', Oc: 'right', Od: 'left', Oe: 'clear',
  '[2^': 'insert', '[3^': 'delete', '[5^': 'pageup',
  '[6^': 'pagedown', '[7^': 'home', '[8^': 'end',
  /* misc */
  '[Z': 'tab',
}

/** rxvt shift-suffixed codes + shift-tab. */
const SHIFT_CODES = new Set([
  '[a', '[b', '[c', '[d', '[e',
  '[2$', '[3$', '[5$', '[6$', '[7$', '[8$', '[Z',
])
/** rxvt ctrl-suffixed codes. */
const CTRL_CODES = new Set([
  'Oa', 'Ob', 'Oc', 'Od', 'Oe',
  '[2^', '[3^', '[5^', '[6^', '[7^', '[8^',
])

export const nonAlphanumericKeys = [
  // Multi-character key names are non-printable; single-char values (numpad
  // digits/operators) are printable and must produce input.
  ...Object.values(KEY_NAME).filter(v => v.length > 1),
  // Assigned directly in the ladder, not via KEY_NAME — without these,
  // ctrl+escape via kitty/modifyOtherKeys leaks the literal word as text.
  'escape',
  'backspace',
  'wheelup',
  'wheeldown',
  'mouse',
]

/** xterm modifier encoding: 1 + shift(1) + alt(2) + ctrl(4) + super(8). */
function decodeModifier(modifier: number): {
  shift: boolean
  meta: boolean
  ctrl: boolean
  super: boolean
} {
  const m = modifier - 1
  return { shift: !!(m & 1), meta: !!(m & 2), ctrl: !!(m & 4), super: !!(m & 8) }
}

/** Keycode → name for CSI-u / modifyOtherKeys (kitty PUA numpad included). */
function keycodeToName(keycode: number): string | undefined {
  switch (keycode) {
    case 9: return 'tab'
    case 13: return 'return'
    case 27: return 'escape'
    case 32: return 'space'
    case 127: return 'backspace'
    case 57399: return '0'
    case 57400: return '1'
    case 57401: return '2'
    case 57402: return '3'
    case 57403: return '4'
    case 57404: return '5'
    case 57405: return '6'
    case 57406: return '7'
    case 57407: return '8'
    case 57408: return '9'
    case 57409: return '.'
    case 57410: return '/'
    case 57411: return '*'
    case 57412: return '-'
    case 57413: return '+'
    case 57414: return 'return'
    case 57415: return '='
    default:
      if (keycode >= 32 && keycode <= 126) {
        return String.fromCharCode(keycode).toLowerCase()
      }
      return undefined
  }
}

/** Chord-name resolution for non-Latin layouts (the CSI-u alternate-key
 *  subfields): the base-layout code first — the physical PC-101 position a
 *  chord is bound to — then the shifted code; undefined when neither maps. */
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

// ── the key grammar ─────────────────────────────────────────────────────────

// The FULL kitty CSI-u grammar:
//   CSI code[:shifted[:base]] [; mods[:event-type]] [; text-codepoints] u
// Colon subfields and the associated-text section are spec-legal richer
// emissions of the same `>1u` push we arm (WT/ConPTY tags event types on
// key-repeat and synthetic input) — the old minimal regex let exactly those
// fall through every grammar into the deliberate nameless swallow, so
// discrete presses acted while repeat bursts and tagged functional keys
// died silently. Release events (:3) swallow BY POLICY (acting would double
// every key); press (:1/absent) and REPEAT (:2) act.
// The shifted/base subfields are CAPTURED (empty-legal, extra subfields
// tolerated): a non-Latin layout types its own codepoint as the primary
// code (Cyrillic ф = 1092), and only the base-layout subfield carries the
// physical position a chord is bound to — see resolveChordNameFromLayout.
const CSI_U_RE = /^\x1b\[(\d+)(?::(\d*))?(?::(\d*))?(?::\d*)*(?:;(\d+)(?::(\d+))?)?(?:;([\d:]+))?u$/
// The same event-type tag on LEGACY functional finals (arrows/nav/F-keys):
//   CSI 1;mods:event {A-Z~} — strip the tag and re-enter the ladder so the
// nav/FN grammars see their canonical spelling; releases swallow.
const EVENT_TYPED_FUNCTIONAL_RE = /^(\x1b\[[\d;]*);(\d+):(\d+)([~A-Za-z])$/
const MODIFY_OTHER_KEYS_RE = /^\x1b\[27;(\d+);(\d+)~/
const META_KEY_CODE_RE = /^(?:\x1b)([a-zA-Z0-9])$/
const FN_KEY_RE =
  /^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))/

function baseKey(s: string): ParsedKey {
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

function modifiedKey(s: string, keycode: number, modifier: number): ParsedKey {
  const mods = decodeModifier(modifier)
  return {
    kind: 'key',
    name: keycodeToName(keycode),
    fn: false,
    ctrl: mods.ctrl,
    meta: mods.meta,
    shift: mods.shift,
    option: false,
    super: mods.super,
    sequence: s,
    raw: s,
    isPasted: false,
  }
}

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
  const key = baseKey(content)
  return { ...key, isPasted: true }
}

/** Interpret one sequence/text unit as a keypress. The clause ORDER is the
 *  contract: CSI-u → modifyOtherKeys (before the FN grammar, which would
 *  half-match its params) → SGR wheel → X10 wheel → the literal ladder →
 *  ESC+alnum meta → the legacy FN grammar → iTerm word-nav → the exact nav
 *  overrides. */
export function interpretKey(s: string = ''): ParsedKey {
  let match: RegExpExecArray | null

  if ((match = CSI_U_RE.exec(s))) {
    // Release (:3) swallows: the nameless base key rides the established
    // empty-input projection downstream — never a second action for the
    // press that already acted.
    if (match[5] === '3') return baseKey(s)
    const key = modifiedKey(s, parseInt(match[1]!, 10), match[4] ? parseInt(match[4], 10) : 1)
    if (key.name === undefined && (key.ctrl || key.meta || key.super)) {
      // THE LAYOUT LAW: a chord binds to the PHYSICAL key, not the typed
      // glyph. On a non-Latin layout the primary code is the layout's own
      // codepoint (ctrl+ф arrives as 1092;5u — no ASCII name), and matching
      // on it alone killed every ctrl/alt/super chord for such layouts. The
      // event's base-layout subfield carries the PC-101 position — resolve
      // the chord name from it, shifted subfield as the fallback. Plain
      // typing (no chord plane) never takes this path: ф must insert ф.
      key.name = resolveChordNameFromLayout(match[3], match[2])
    }
    if (match[6] && !key.ctrl && !key.meta) {
      // Associated text: the terminal's own statement of what was typed —
      // it names the key (a shifted 'a' arrives keycode 97 + text 65 and
      // must insert 'A', not 'a').
      const text = match[6]
        .split(':')
        .map(cp => String.fromCodePoint(parseInt(cp, 10)))
        .join('')
      if (text.length > 0) key.name = text
    }
    return key
  }
  if ((match = EVENT_TYPED_FUNCTIONAL_RE.exec(s))) {
    if (match[3] === '3') return baseKey(s)
    return interpretKey(`${match[1]};${match[2]}${match[4]}`)
  }
  if ((match = MODIFY_OTHER_KEYS_RE.exec(s))) {
    // Param order is REVERSED vs CSI-u: modifier first, keycode second.
    return modifiedKey(s, parseInt(match[2]!, 10), parseInt(match[1]!, 10))
  }

  // SGR wheel: mask 0x43 (wheel flag + direction) so MODIFIED wheel events
  // (ctrl+scroll = 80/81) still scroll. Non-wheel SGR was already taken by
  // interpretMouse.
  if ((match = SGR_MOUSE_RE.exec(s))) {
    const button = parseInt(match[1]!, 10)
    // Wheel keys carry the pointer cell (1-based col;row from the SGR
    // params) — the wheel-under-pointer routing seam.
    const x = parseInt(match[2]!, 10)
    const y = parseInt(match[3]!, 10)
    if ((button & 0x43) === 0x40) return { ...navKey(s, 'wheelup', false), x, y }
    if ((button & 0x43) === 0x41) return { ...navKey(s, 'wheeldown', false), x, y }
    return navKey(s, 'mouse', false)
  }
  // X10 wheel (6 chars: ESC [ M + 3 payload). Clicks/drags are swallowed as
  // 'mouse' — tracking is alt-screen-only and only wheel is needed there.
  if (s.length === 6 && s.startsWith('\x1b[M')) {
    const button = s.charCodeAt(3) - 32
    const x = s.charCodeAt(4) - 32
    const y = s.charCodeAt(5) - 32
    if ((button & 0x43) === 0x40) return { ...navKey(s, 'wheelup', false), x, y }
    if ((button & 0x43) === 0x41) return { ...navKey(s, 'wheeldown', false), x, y }
    return navKey(s, 'mouse', false)
  }

  const key = baseKey(s)
  key.sequence = key.sequence || s || key.name

  let parts: RegExpExecArray | null
  if (s === '\r') {
    key.raw = undefined
    key.name = 'return'
  } else if (s === '\n') {
    key.name = 'enter'
  } else if (s === '\t') {
    key.name = 'tab'
  } else if (s === '\b' || s === '\x1b\b') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x7f' || s === '\x1b\x7f') {
    key.name = 'backspace'
    key.meta = s.charAt(0) === '\x1b'
  } else if (s === '\x1b' || s === '\x1b\x1b') {
    key.name = 'escape'
    key.meta = s.length === 2
  } else if (s === ' ' || s === '\x1b ') {
    key.name = 'space'
    key.meta = s.length === 2
  } else if (s === '\x1f') {
    key.name = '_'
    key.ctrl = true
  } else if (s <= '\x1a' && s.length === 1) {
    // C0 control = ctrl+letter.
    key.name = String.fromCharCode(s.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
    key.ctrl = true
  } else if (s.length === 1 && s >= '0' && s <= '9') {
    key.name = 'number'
  } else if (s.length === 1 && s >= 'a' && s <= 'z') {
    key.name = s
  } else if (s.length === 1 && s >= 'A' && s <= 'Z') {
    key.name = s.toLowerCase()
    key.shift = true
  } else if ((parts = META_KEY_CODE_RE.exec(s))) {
    key.meta = true
    key.shift = /^[A-Z]$/.test(parts[1]!)
  } else if ((parts = FN_KEY_RE.exec(s))) {
    // An extra ESC prefix = option (iTerm option-as-meta double-escape).
    const segs = [...s]
    if (segs[0] === '\u001b' && segs[1] === '\u001b') {
      key.option = true
    }
    const code = [parts[1], parts[2], parts[4], parts[6]].filter(Boolean).join('')
    const modifier = ((parts[3] || parts[5] || 1) as number) - 1
    key.ctrl = !!(modifier & 4)
    key.meta = !!(modifier & 2)
    key.super = !!(modifier & 8)
    key.shift = !!(modifier & 1)
    key.code = code
    key.name = KEY_NAME[code]
    key.shift = SHIFT_CODES.has(code) || key.shift
    key.ctrl = CTRL_CODES.has(code) || key.ctrl
  }

  // iTerm natural text editing (option-arrow as ESC b / ESC f).
  if (key.raw === '\x1Bb') {
    key.meta = true
    key.name = 'left'
  } else if (key.raw === '\x1Bf') {
    key.meta = true
    key.name = 'right'
  }

  // The exact nav overrides — these six sequences yield a bare nav key
  // (no code field) regardless of what the grammar above concluded.
  switch (s) {
    case '\u001b[1~': return navKey(s, 'home', false)
    case '\u001b[4~': return navKey(s, 'end', false)
    case '\u001b[5~': return navKey(s, 'pageup', false)
    case '\u001b[6~': return navKey(s, 'pagedown', false)
    case '\u001b[1;5D': return navKey(s, 'left', true)
    case '\u001b[1;5C': return navKey(s, 'right', true)
  }

  return key
}

// ── orphaned mouse extraction (the fast-scroll ESC race) ────────────────────
// A flush ate the ESC; the event bytes arrive later as plain TEXT. Complete
// events re-synthesize with their ESC; head-truncated coordinate fragments
// are unrecoverable garbage and are dropped, never leaked into the prompt.

const ORPHAN_MOUSE_PROBE_RE =
  /^\[(?:<\d+;\d+;\d+[Mm]|M[\x60-\x7f][\x20-￿]{2})|\d+;\d+;\d+[Mm]/
const ORPHAN_MOUSE_EVENT_RE =
  /\[<\d+;\d+;\d+[Mm]|\[M[\x60-\x7f][\x20-￿]{2}|\[?<?\d+;\d+;\d+[Mm]/g
const MOUSE_FRAGMENT_RE = /^(?:<?\d*;?\d*;?\d*[Mm]?|<\d*)$/

/** Does this text token look like it carries orphaned mouse bytes? */
export function hasOrphanMouseBytes(text: string): boolean {
  return ORPHAN_MOUSE_PROBE_RE.test(text)
}

/** Extract every embedded mouse event from an ESC-less text token into
 *  `out`; preserve genuine text between events; drop bare fragments. */
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
    // Only `[`-led matches are complete events; the rest lost their head.
    if (m[0][0] !== '[') continue
    const resynthesized = '\x1b' + m[0]
    const mouse = interpretMouse(resynthesized)
    if (mouse) out.push(mouse)
    else out.push(interpretKey(resynthesized))
  }
  if (last < text.length) emitText(text.slice(last))
}
