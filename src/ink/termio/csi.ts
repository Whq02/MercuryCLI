import { asBytes, byteRange, ESC, SEP } from './ansi.js'

const CSI_PREFIX = `${ESC}[`

export const isCSIIntermediate = byteRange(0x20, 0x2f)
export const isCSIParam = byteRange(0x30, 0x3f)
export const isCSIFinal = byteRange(0x40, 0x7e)

const FINAL_LETTERS = {
  CUU: 'A',
  CUD: 'B',
  CUF: 'C',
  CUB: 'D',
  CNL: 'E',
  CPL: 'F',
  CHA: 'G',
  CUP: 'H',
  CHT: 'I',
  ED: 'J',
  EL: 'K',
  IL: 'L',
  DL: 'M',
  DCH: 'P',
  SU: 'S',
  SD: 'T',
  ECH: 'X',
  CBT: 'Z',
  ICH: '@',
  VPA: 'd',
  HVP: 'f',
  SM: 'h',
  RM: 'l',
  SGR: 'm',
  DSR: 'n',
  DECSCUSR: 'q',
  DECSTBM: 'r',
  SCOSC: 's',
  SCORC: 'u',
} as const

export const CSI = asBytes(FINAL_LETTERS)

export function csi(...body: (string | number)[]): string {
  const final = body.length > 1 ? body.pop() ?? '' : ''
  return `${CSI_PREFIX}${body.join(SEP)}${final}`
}

export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

type CursorStyle = 'block' | 'underline' | 'bar'

const CURSOR_SHAPES: readonly CursorStyle[] = ['block', 'underline', 'bar']

export const CURSOR_STYLES: ReadonlyArray<{ style: CursorStyle; blinking: boolean }> = [
  { style: 'block', blinking: true },
  ...CURSOR_SHAPES.flatMap(style => [
    { style, blinking: true },
    { style, blinking: false },
  ]),
]

const counted =
  (final: string) =>
  (n = 1): string =>
    n === 0 ? '' : csi(n, final)

export const cursorUp = counted(FINAL_LETTERS.CUU)
export const cursorDown = counted(FINAL_LETTERS.CUD)
export const cursorForward = counted(FINAL_LETTERS.CUF)
export const cursorBack = counted(FINAL_LETTERS.CUB)
export const scrollUp = counted(FINAL_LETTERS.SU)
export const scrollDown = counted(FINAL_LETTERS.SD)

const signed = (n: number, positive: (n: number) => string, negative: (n: number) => string): string =>
  n > 0 ? positive(n) : n < 0 ? negative(-n) : ''

export function cursorMove(x: number, y: number): string {
  return signed(x, cursorForward, cursorBack) + signed(y, cursorDown, cursorUp)
}

export const cursorTo = (col: number): string => csi(col, FINAL_LETTERS.CHA)
export const cursorPosition = (row: number, col: number): string => csi(row, col, FINAL_LETTERS.CUP)
export const CURSOR_HOME = csi(FINAL_LETTERS.CUP)
const CURSOR_COLUMN_ONE = csi(FINAL_LETTERS.CHA)

export const eraseToEndOfLine = (): string => csi(FINAL_LETTERS.EL)
export const eraseToEndOfScreen = (): string => csi(FINAL_LETTERS.ED)
const ERASE_WHOLE_LINE = csi(2, FINAL_LETTERS.EL)
export const ERASE_SCREEN = csi(2, FINAL_LETTERS.ED)
export const ERASE_SCROLLBACK = csi(3, FINAL_LETTERS.ED)

export function eraseLines(n: number): string {
  if (n <= 0) return ''
  const wholeLines = Array.from({ length: n }, () => ERASE_WHOLE_LINE)
  return wholeLines.join(cursorUp(1)) + CURSOR_COLUMN_ONE
}

export const setScrollRegion = (top: number, bottom: number): string =>
  csi(top, bottom, FINAL_LETTERS.DECSTBM)
export const RESET_SCROLL_REGION = csi(FINAL_LETTERS.DECSTBM)

export const PASTE_START = csi('200~')
export const PASTE_END = csi('201~')
export const FOCUS_IN = csi('I')
export const FOCUS_OUT = csi('O')

export const ENABLE_KITTY_KEYBOARD = csi('>5u')
export const DISABLE_KITTY_KEYBOARD = csi('<u')
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
