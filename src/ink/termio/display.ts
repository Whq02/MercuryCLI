
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { isHebrewArabicCombiningMark } from '../stringWidth.js'
import { createScanner, type Scanner, type TokenKind } from '../input/scanner.js'
import { CSI, CURSOR_STYLES, ERASE_DISPLAY, ERASE_LINE_REGION } from './csi.js'
import { DEC } from './dec.js'
import { parseOSC } from './osc.js'
import type {
  Action,
  Grapheme,
  NamedColor,
  TextStyle,
  UnderlineStyle,
} from './display-types.js'
import { defaultStyle } from './display-types.js'


const WIDE_RANGES: readonly number[] = [
  0x1100, 0x115f,
  0x2600, 0x26ff,
  0x2700, 0x27bf,
  0x2e80, 0x9fff,
  0xac00, 0xd7a3,
  0xf900, 0xfaff,
  0xfe10, 0xfe1f,
  0xfe30, 0xfe6f,
  0xff00, 0xff60,
  0xffe0, 0xffe6,
  0x1f1e0, 0x1f1ff,
  0x1f300, 0x1f9ff,
  0x1fa00, 0x1faff,
  0x20000, 0x2fffd,
  0x30000, 0x3fffd,
]

function onlyHebrewArabicMarksAfterBase(grapheme: string, baseUnits: number): boolean {
  for (let i = baseUnits; i < grapheme.length; i++) {
    if (!isHebrewArabicCombiningMark(grapheme.charCodeAt(i))) return false
  }
  return true
}

function graphemeWidth(grapheme: string): 1 | 2 {
  const first = grapheme.codePointAt(0)
  if (first === undefined) return 1
  const baseUnits = first > 0xffff ? 2 : 1
  if (grapheme.length > baseUnits && !onlyHebrewArabicMarksAfterBase(grapheme, baseUnits)) {
    return 2
  }
  if (first < 0x1100) return 1
  for (let i = 0; i < WIDE_RANGES.length; i += 2) {
    if (first >= WIDE_RANGES[i]! && first <= WIDE_RANGES[i + 1]!) return 2
  }
  return 1
}

function batchGraphemes(text: string): Grapheme[] {
  const graphemes: Grapheme[] = []
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    graphemes.push({ value: segment, width: graphemeWidth(segment) })
  }
  return graphemes
}


const NAMED_COLORS: readonly NamedColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

const UNDERLINE_STYLES: readonly UnderlineStyle[] = [
  'none',
  'single',
  'double',
  'curly',
  'dotted',
  'dashed',
]

type SgrGroup = { n: number | null; colon: boolean; sub: number[] }

function unitValue(unit: string): number | null {
  let digits = ''
  for (const ch of unit) {
    if (ch >= '0' && ch <= '9') digits += ch
  }
  return digits === '' ? null : parseInt(digits, 10)
}

function sgrGroups(raw: string): SgrGroup[] {
  if (raw === '') return [{ n: 0, colon: false, sub: [] }]
  return raw.split(';').map(piece => {
    const units = piece.split(':')
    const sub: number[] = []
    for (let u = 1; u < units.length; u++) {
      const v = unitValue(units[u]!)
      if (v !== null) sub.push(v)
    }
    return { n: unitValue(units[0]!), colon: units.length > 1, sub }
  })
}

type ExtendedColor =
  | { kind: 'indexed'; index: number }
  | { kind: 'rgb'; r: number; g: number; b: number }

function resolveExtendedColor(
  groups: SgrGroup[],
  i: number,
): { color: ExtendedColor; extra: number } | null {
  const g = groups[i]!
  if (g.colon && g.sub.length >= 1) {
    if (g.sub[0] === 5 && g.sub.length >= 2) {
      return { color: { kind: 'indexed', index: g.sub[1]! }, extra: 0 }
    }
    if (g.sub[0] === 2 && g.sub.length >= 4) {
      const off = g.sub.length >= 5 ? 1 : 0
      return {
        color: {
          kind: 'rgb',
          r: g.sub[1 + off]!,
          g: g.sub[2 + off]!,
          b: g.sub[3 + off]!,
        },
        extra: 0,
      }
    }
  }
  const next = groups[i + 1]
  if (!next) return null
  if (next.n === 5 && groups[i + 2]?.n != null) {
    return {
      color: { kind: 'indexed', index: groups[i + 2]!.n! },
      extra: g.colon ? 0 : 2,
    }
  }
  if (next.n === 2) {
    const r = groups[i + 2]?.n
    const gg = groups[i + 3]?.n
    const b = groups[i + 4]?.n
    if (r != null && gg != null && b != null) {
      return { color: { kind: 'rgb', r, g: gg, b }, extra: g.colon ? 0 : 4 }
    }
  }
  return null
}

function toColor(c: ExtendedColor): TextStyle['fg'] {
  return c.kind === 'indexed'
    ? { type: 'indexed', index: c.index }
    : { type: 'rgb', r: c.r, g: c.g, b: c.b }
}

export function foldSgr(raw: string, prev: TextStyle): TextStyle {
  const groups = sgrGroups(raw)
  let s: TextStyle = { ...prev }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!
    const code = g.n ?? 0
    switch (code) {
      case 0:
        s = defaultStyle()
        break
      case 1:
        s.bold = true
        break
      case 2:
        s.dim = true
        break
      case 3:
        s.italic = true
        break
      case 4:
        s.underline = g.colon
          ? (UNDERLINE_STYLES[g.sub[0]!] ?? 'single')
          : 'single'
        break
      case 5:
      case 6:
        s.blink = true
        break
      case 7:
        s.inverse = true
        break
      case 8:
        s.hidden = true
        break
      case 9:
        s.strikethrough = true
        break
      case 21:
        s.underline = 'double'
        break
      case 22:
        s.bold = false
        s.dim = false
        break
      case 23:
        s.italic = false
        break
      case 24:
        s.underline = 'none'
        break
      case 25:
        s.blink = false
        break
      case 27:
        s.inverse = false
        break
      case 28:
        s.hidden = false
        break
      case 29:
        s.strikethrough = false
        break
      case 39:
        s.fg = { type: 'default' }
        break
      case 49:
        s.bg = { type: 'default' }
        break
      case 53:
        s.overline = true
        break
      case 55:
        s.overline = false
        break
      case 59:
        s.underlineColor = { type: 'default' }
        break
      case 38:
      case 48:
      case 58: {
        const resolved = resolveExtendedColor(groups, i)
        if (resolved) {
          const color = toColor(resolved.color)
          if (code === 38) s.fg = color
          else if (code === 48) s.bg = color
          else s.underlineColor = color
          i += resolved.extra
        }
        break
      }
      default:
        if (code >= 30 && code <= 37) s.fg = { type: 'named', name: NAMED_COLORS[code - 30]! }
        else if (code >= 40 && code <= 47) s.bg = { type: 'named', name: NAMED_COLORS[code - 40]! }
        else if (code >= 90 && code <= 97) s.fg = { type: 'named', name: NAMED_COLORS[code - 90 + 8]! }
        else if (code >= 100 && code <= 107) s.bg = { type: 'named', name: NAMED_COLORS[code - 100 + 8]! }
        break
    }
  }
  return s
}


function csiParams(paramStr: string): number[] {
  if (paramStr === '') return []
  return paramStr.split(/[;:]/).map(s => (s === '' ? 0 : parseInt(s, 10)))
}

type CsiParts = {
  privateMode: string
  paramStr: string
  intermediate: string
  finalByte: number
}

function splitCsi(rawSequence: string): CsiParts | null {
  const inner = rawSequence.slice(2)
  if (inner.length === 0) return null
  const finalByte = inner.charCodeAt(inner.length - 1)
  let paramStr = inner.slice(0, -1)
  let privateMode = ''
  if (paramStr.length > 0 && '?>='.includes(paramStr[0]!)) {
    privateMode = paramStr[0]!
    paramStr = paramStr.slice(1)
  }
  let intermediate = ''
  const m = paramStr.match(/([^0-9;:]+)$/)
  if (m) {
    intermediate = m[1]!
    paramStr = paramStr.slice(0, -intermediate.length)
  }
  return { privateMode, paramStr, intermediate, finalByte }
}

function decModeAction(mode: number, enabled: boolean): Action | null {
  switch (mode) {
    case DEC.CURSOR_VISIBLE:
      return { type: 'cursor', action: enabled ? { type: 'show' } : { type: 'hide' } }
    case DEC.ALT_SCREEN:
    case DEC.ALT_SCREEN_CLEAR:
      return { type: 'mode', action: { type: 'alternateScreen', enabled } }
    case DEC.BRACKETED_PASTE:
      return { type: 'mode', action: { type: 'bracketedPaste', enabled } }
    case DEC.MOUSE_NORMAL:
      return { type: 'mode', action: { type: 'mouseTracking', mode: enabled ? 'normal' : 'off' } }
    case DEC.MOUSE_BUTTON:
      return { type: 'mode', action: { type: 'mouseTracking', mode: enabled ? 'button' : 'off' } }
    case DEC.MOUSE_ANY:
      return { type: 'mode', action: { type: 'mouseTracking', mode: enabled ? 'any' : 'off' } }
    case DEC.FOCUS_EVENTS:
      return { type: 'mode', action: { type: 'focusEvents', enabled } }
    default:
      return null
  }
}

function interpretCsi(rawSequence: string): Action | null {
  const parts = splitCsi(rawSequence)
  if (!parts) return null
  const { privateMode, paramStr, intermediate, finalByte } = parts
  const params = csiParams(paramStr)
  const p0 = params[0] ?? 1
  const p1 = params[1] ?? 1

  if (finalByte === CSI.SGR && privateMode === '') {
    return { type: 'sgr', params: paramStr }
  }

  switch (finalByte) {
    case CSI.CUU:
      return { type: 'cursor', action: { type: 'move', direction: 'up', count: p0 } }
    case CSI.CUD:
      return { type: 'cursor', action: { type: 'move', direction: 'down', count: p0 } }
    case CSI.CUF:
      return { type: 'cursor', action: { type: 'move', direction: 'forward', count: p0 } }
    case CSI.CUB:
      return { type: 'cursor', action: { type: 'move', direction: 'back', count: p0 } }
    case CSI.CNL:
      return { type: 'cursor', action: { type: 'nextLine', count: p0 } }
    case CSI.CPL:
      return { type: 'cursor', action: { type: 'prevLine', count: p0 } }
    case CSI.CHA:
      return { type: 'cursor', action: { type: 'column', col: p0 } }
    case CSI.CUP:
    case CSI.HVP:
      return { type: 'cursor', action: { type: 'position', row: p0, col: p1 } }
    case CSI.VPA:
      return { type: 'cursor', action: { type: 'row', row: p0 } }

    case CSI.ED:
      return {
        type: 'erase',
        action: { type: 'display', region: ERASE_DISPLAY[params[0] ?? 0] ?? 'toEnd' },
      }
    case CSI.EL:
      return {
        type: 'erase',
        action: { type: 'line', region: ERASE_LINE_REGION[params[0] ?? 0] ?? 'toEnd' },
      }
    case CSI.ECH:
      return { type: 'erase', action: { type: 'chars', count: p0 } }

    case CSI.SU:
      return { type: 'scroll', action: { type: 'up', count: p0 } }
    case CSI.SD:
      return { type: 'scroll', action: { type: 'down', count: p0 } }
    case CSI.DECSTBM:
      return { type: 'scroll', action: { type: 'setRegion', top: p0, bottom: p1 } }

    case CSI.SCOSC:
      return { type: 'cursor', action: { type: 'save' } }
    case CSI.SCORC:
      return { type: 'cursor', action: { type: 'restore' } }
    case CSI.DECSCUSR:
      if (intermediate === ' ') {
        const styleInfo = CURSOR_STYLES[p0] ?? CURSOR_STYLES[0]!
        return { type: 'cursor', action: { type: 'style', ...styleInfo } }
      }
      break

    case CSI.SM:
    case CSI.RM:
      if (privateMode === '?') {
        const action = decModeAction(p0, finalByte === CSI.SM)
        if (action) return action
      }
      break
  }

  return { type: 'unknown', sequence: rawSequence }
}


const ESC_ACTIONS: Readonly<Record<string, Action | null>> = {
  c: { type: 'reset' },
  '7': { type: 'cursor', action: { type: 'save' } },
  '8': { type: 'cursor', action: { type: 'restore' } },
  D: { type: 'cursor', action: { type: 'move', direction: 'down', count: 1 } },
  M: { type: 'cursor', action: { type: 'move', direction: 'up', count: 1 } },
  E: { type: 'cursor', action: { type: 'nextLine', count: 1 } },
  H: null,
}

function interpretEsc(rawSequence: string): Action | null {
  const chars = rawSequence.slice(1)
  if (chars.length === 0) return null
  const first = chars[0]!
  if (first in ESC_ACTIONS) return ESC_ACTIONS[first]!
  if ((first === '(' || first === ')') && chars.length >= 2) return null
  return { type: 'unknown', sequence: rawSequence }
}


function oscContent(rawSequence: string): string {
  let content = rawSequence.slice(2)
  if (content.endsWith('\x07')) return content.slice(0, -1)
  if (content.endsWith('\x1b\\')) return content.slice(0, -2)
  return content
}


export class Parser {
  private scanner: Scanner = createScanner()

  style: TextStyle = defaultStyle()
  inLink = false
  linkUrl: string | undefined

  reset(): void {
    this.scanner.reset()
    this.style = defaultStyle()
    this.inLink = false
    this.linkUrl = undefined
  }

  feed(input: string): Action[] {
    const actions: Action[] = []
    for (const token of this.scanner.feed(input)) {
      this.interpret(token.kind, token.value, actions)
    }
    return actions
  }

  private interpret(kind: TokenKind, value: string, out: Action[]): void {
    switch (kind) {
      case 'text':
        this.emitText(value, out)
        return
      case 'csi': {
        const action = interpretCsi(value)
        if (!action) return
        if (action.type === 'sgr') {
          this.style = foldSgr(action.params, this.style)
          return
        }
        out.push(action)
        return
      }
      case 'osc': {
        const action = parseOSC(oscContent(value))
        if (!action) return
        if (action.type === 'link') {
          if (action.action.type === 'start') {
            this.inLink = true
            this.linkUrl = action.action.url
          } else {
            this.inLink = false
            this.linkUrl = undefined
          }
        }
        out.push(action)
        return
      }
      case 'esc': {
        if (value.length < 2) {
          out.push({ type: 'unknown', sequence: value })
          return
        }
        const action = interpretEsc(value)
        if (action) out.push(action)
        return
      }
      default:
        out.push({ type: 'unknown', sequence: value })
        return
    }
  }

  private emitText(text: string, out: Action[]): void {
    if (text.indexOf('\x07') === -1) {
      const graphemes = batchGraphemes(text)
      if (graphemes.length > 0) {
        out.push({ type: 'text', graphemes, style: { ...this.style } })
      }
      return
    }
    const pieces = text.split('\x07')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!
      if (piece) {
        const graphemes = batchGraphemes(piece)
        if (graphemes.length > 0) {
          out.push({ type: 'text', graphemes, style: { ...this.style } })
        }
      }
      if (i < pieces.length - 1) out.push({ type: 'bell' })
    }
  }
}
