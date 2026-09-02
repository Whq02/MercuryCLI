// CSI generation: the byte-class predicates, the final-byte table, the
// cursor / erase / scroll generators, and the terminal→application markers.

import { ESC, SEP } from './ansi.js'

export const CSI_PREFIX = `${ESC}[`

/** CSI byte ranges: parameter, intermediate and final bytes. */
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

/** The final-byte table by mnemonic, as byte values. */
export const CSI = {
  CUU: 0x41, // A
  CUD: 0x42, // B
  CUF: 0x43, // C
  CUB: 0x44, // D
  CNL: 0x45, // E
  CPL: 0x46, // F
  CHA: 0x47, // G
  CUP: 0x48, // H
  CHT: 0x49, // I
  VPA: 0x64, // d
  HVP: 0x66, // f
  ED: 0x4a, // J
  EL: 0x4b, // K
  ECH: 0x58, // X
  IL: 0x4c, // L
  DL: 0x4d, // M
  ICH: 0x40, // @
  DCH: 0x50, // P
  SU: 0x53, // S
  SD: 0x54, // T
  SM: 0x68, // h
  RM: 0x6c, // l
  SGR: 0x6d, // m
  DSR: 0x6e, // n
  DECSCUSR: 0x71, // q
  DECSTBM: 0x72, // r
  SCOSC: 0x73, // s
  SCORC: 0x75, // u
  CBT: 0x5a, // Z
} as const

/**
 * Build `ESC [ <params joined by ';'> <final>`. No arguments → the bare
 * introducer; exactly one → an already-formed body; two or more → the last
 * is the final byte, the rest are parameters.
 */
export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const final = args[args.length - 1]
  const params = args.slice(0, -1)
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

/** Erase-region names in parameter order. */
export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

export type CursorStyle = 'block' | 'underline' | 'bar'

/** DECSCUSR parameter 0–6 → cursor style. */
export const CURSOR_STYLES: ReadonlyArray<{ style: CursorStyle; blinking: boolean }> = [
  { style: 'block', blinking: true },
  { style: 'block', blinking: true },
  { style: 'block', blinking: false },
  { style: 'underline', blinking: true },
  { style: 'underline', blinking: false },
  { style: 'bar', blinking: true },
  { style: 'bar', blinking: false },
]

// ── cursor movement (a count of 0 is the empty string, never a no-op
// sequence) ────────────────────────────────────────────────────────────────

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

/** Move to a 1-indexed column. */
export function cursorTo(col: number): string {
  return csi(col, 'G')
}
export const CURSOR_LEFT = csi('G')

/** Move to a 1-indexed row/column. */
export function cursorPosition(row: number, col: number): string {
  return csi(row, col, 'H')
}
export const CURSOR_HOME = csi('H')

/** Relative move: the horizontal component first, then vertical, each
 *  omitted when zero (the order is observable under line wrapping). */
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

// ── erase ──────────────────────────────────────────────────────────────────

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

/** Erase `n` lines upward: whole-line erases with a cursor-up between each
 *  pair (not after the last), then a move to column 1. */
export function eraseLines(n: number): string {
  if (n <= 0) return ''
  let out = ''
  for (let i = 0; i < n; i++) {
    out += ERASE_LINE
    if (i < n - 1) out += cursorUp(1)
  }
  return out + CURSOR_LEFT
}

// ── scroll ─────────────────────────────────────────────────────────────────

export function scrollUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'S')
}
export function scrollDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'T')
}
/** 1-indexed, inclusive. */
export function setScrollRegion(top: number, bottom: number): string {
  return csi(top, bottom, 'r')
}
/** Also homes the cursor as a side effect on real terminals. */
export const RESET_SCROLL_REGION = csi('r')

// ── terminal → application markers ────────────────────────────────────────

export const PASTE_START = csi('200~')
export const PASTE_END = csi('201~')
export const FOCUS_IN = csi('I')
export const FOCUS_OUT = csi('O')

// ── enhanced keyboard ──────────────────────────────────────────────────────

/** Push the kitty keyboard flags: 0b1 disambiguate escape codes + 0b100
 *  report alternate keys. The alternate-key subfields (shifted:base-layout)
 *  ride ONLY under 0b100 — the layout law's chord resolution reads the
 *  base-layout position from them, and a 0b1-only push leaves a non-Latin
 *  layout's ctrl/alt/super chords nameless on every spec-compliant
 *  terminal (the reader waits for data the request never invites). Plain
 *  typing is untouched: 0b100 adds subfields only to events already
 *  escape-coded, and 0b1000/0b10000 stay unset. */
export const ENABLE_KITTY_KEYBOARD = csi('>5u')
/** Pop them. */
export const DISABLE_KITTY_KEYBOARD = csi('<u')
/** xterm modifyOtherKeys level 2 — tmux accepts this rather than the kitty
 *  stack and (with its extended-keys format set to CSI-u) re-emits keys in
 *  kitty form. */
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
