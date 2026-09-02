
import { ESC, SEP } from './ansi.js'

export const CSI_PREFIX = `${ESC}[`

export const CSI_RANGE = {
  PARAM_MIN: 0x30,
  PARAM_MAX: 0x3f,
  INTERMEDIATE_MIN: 0x20,
  INTERMEDIATE_MAX: 0x2f,
  FINAL_MIN: 0x40,
  FINAL_MAX: 0x7e,
} as const

export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_MIN && byte <= CSI_RANGE.PARAM_MAX
}

export function isCSIIntermediate(byte: number): boolean {
  return byte >= CSI_RANGE.INTERMEDIATE_MIN && byte <= CSI_RANGE.INTERMEDIATE_MAX
}

export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_MIN && byte <= CSI_RANGE.FINAL_MAX
}

export const CSI = {
  CUU: 0x41,
  CUD: 0x42,
  CUF: 0x43,
  CUB: 0x44,
  CNL: 0x45,
  CPL: 0x46,
  CHA: 0x47,
  CUP: 0x48,
  CHT: 0x49,
  VPA: 0x64,
  HVP: 0x66,
  ED: 0x4a,
  EL: 0x4b,
  ECH: 0x58,
  IL: 0x4c,
  DL: 0x4d,
  ICH: 0x40,
  DCH: 0x50,
  SU: 0x53,
  SD: 0x54,
  SM: 0x68,
  RM: 0x6c,
  SGR: 0x6d,
  DSR: 0x6e,
  DECSCUSR: 0x71,
  DECSTBM: 0x72,
  SCOSC: 0x73,
  SCORC: 0x75,
  CBT: 0x5a,
} as const

export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const final = args[args.length - 1]
  const params = args.slice(0, -1)
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

export type CursorStyle = 'block' | 'underline' | 'bar'

export const CURSOR_STYLES: ReadonlyArray<{ style: CursorStyle; blinking: boolean }> = [
  { style: 'block', blinking: true },
  { style: 'block', blinking: true },
  { style: 'block', blinking: false },
  { style: 'underline', blinking: true },
  { style: 'underline', blinking: false },
  { style: 'bar', blinking: true },
  { style: 'bar', blinking: false },
]


export function cursorUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'A')
}
export function cursorDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'B')
}
export function cursorForward(n = 1): string {
  return n === 0 ? '' : csi(n, 'C')
}
export function cursorBack(n = 1): string {
  return n === 0 ? '' : csi(n, 'D')
}

export function cursorTo(col: number): string {
  return csi(col, 'G')
}
export const CURSOR_LEFT = csi('G')

export function cursorPosition(row: number, col: number): string {
  return csi(row, col, 'H')
}
export const CURSOR_HOME = csi('H')

export function cursorMove(x: number, y: number): string {
  let out = ''
  if (x > 0) out += cursorForward(x)
  else if (x < 0) out += cursorBack(-x)
  if (y > 0) out += cursorDown(y)
  else if (y < 0) out += cursorUp(-y)
  return out
}

export const CURSOR_SAVE = csi('s')
export const CURSOR_RESTORE = csi('u')


export function eraseToEndOfLine(): string {
  return csi('K')
}
export function eraseToStartOfLine(): string {
  return csi(1, 'K')
}
export function eraseLine(): string {
  return csi(2, 'K')
}
export const ERASE_LINE = eraseLine()

export function eraseToEndOfScreen(): string {
  return csi('J')
}
export function eraseToStartOfScreen(): string {
  return csi(1, 'J')
}
export function eraseScreen(): string {
  return csi(2, 'J')
}
export const ERASE_SCREEN = eraseScreen()
export const ERASE_SCROLLBACK = csi(3, 'J')

export function eraseLines(n: number): string {
  if (n <= 0) return ''
  let out = ''
  for (let i = 0; i < n; i++) {
    out += ERASE_LINE
    if (i < n - 1) out += cursorUp(1)
  }
  return out + CURSOR_LEFT
}


export function scrollUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'S')
}
export function scrollDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'T')
}
export function setScrollRegion(top: number, bottom: number): string {
  return csi(top, bottom, 'r')
}
export const RESET_SCROLL_REGION = csi('r')


export const PASTE_START = csi('200~')
export const PASTE_END = csi('201~')
export const FOCUS_IN = csi('I')
export const FOCUS_OUT = csi('O')


export const ENABLE_KITTY_KEYBOARD = csi('>5u')
export const DISABLE_KITTY_KEYBOARD = csi('<u')
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
