
import { csi } from './csi.js'

export const DEC = {
  ALT_SCREEN_CLEAR: 1049,
  ALT_SCREEN: 47,
  CURSOR_VISIBLE: 25,
  SYNCHRONIZED_UPDATE: 2026,
  BRACKETED_PASTE: 2004,
  FOCUS_EVENTS: 1004,
  ALTERNATE_SCROLL: 1007,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
} as const

const MOUSE_TRACKING_MODES = [DEC.MOUSE_NORMAL, DEC.MOUSE_BUTTON, DEC.MOUSE_ANY, DEC.MOUSE_SGR] as const

export function decset(mode: number): string {
  return csi(`?${mode}h`)
}

export function decreset(mode: number): string {
  return csi(`?${mode}l`)
}

export const BSU = decset(DEC.SYNCHRONIZED_UPDATE)
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE)
export const EBP = decset(DEC.BRACKETED_PASTE)
export const DBP = decreset(DEC.BRACKETED_PASTE)
export const EFE = decset(DEC.FOCUS_EVENTS)
export const DFE = decreset(DEC.FOCUS_EVENTS)
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE)
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE)
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR)
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR)

export const ENABLE_MOUSE_TRACKING =
  MOUSE_TRACKING_MODES.map(decset).join('')
export const DISABLE_MOUSE_TRACKING =
  MOUSE_TRACKING_MODES.map(decreset).reverse().join('')

export const ENABLE_ALTERNATE_SCROLL = decset(DEC.ALTERNATE_SCROLL)
export const DISABLE_ALTERNATE_SCROLL = decreset(DEC.ALTERNATE_SCROLL)
