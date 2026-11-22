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

function set(mode: number): string {
  return csi(`?${mode}h`)
}

function reset(mode: number): string {
  return csi(`?${mode}l`)
}

export const BSU = set(DEC.SYNCHRONIZED_UPDATE)
export const ESU = reset(DEC.SYNCHRONIZED_UPDATE)
export const EBP = set(DEC.BRACKETED_PASTE)
export const DBP = reset(DEC.BRACKETED_PASTE)
export const EFE = set(DEC.FOCUS_EVENTS)
export const DFE = reset(DEC.FOCUS_EVENTS)
export const SHOW_CURSOR = set(DEC.CURSOR_VISIBLE)
export const HIDE_CURSOR = reset(DEC.CURSOR_VISIBLE)
export const ENTER_ALT_SCREEN = set(DEC.ALT_SCREEN_CLEAR)
export const EXIT_ALT_SCREEN = reset(DEC.ALT_SCREEN_CLEAR)

const MOUSE_TRACKING_MODES = [DEC.MOUSE_NORMAL, DEC.MOUSE_BUTTON, DEC.MOUSE_ANY, DEC.MOUSE_SGR] as const

export const ENABLE_MOUSE_TRACKING = MOUSE_TRACKING_MODES.map(set).join('')
export const DISABLE_MOUSE_TRACKING = MOUSE_TRACKING_MODES.toReversed().map(reset).join('')

export const ENABLE_ALTERNATE_SCROLL = set(DEC.ALTERNATE_SCROLL)
export const DISABLE_ALTERNATE_SCROLL = reset(DEC.ALTERNATE_SCROLL)
