// DEC private-mode numbers and the composed enable/disable sets. Mouse
// tracking is a four-segment composite armed on EVERY platform; alternate
// scroll (1007) is independent of it and rides the whole alternate-screen
// lifetime — inert while tracking is on, taking over the moment tracking
// goes off so the wheel still scrolls the application.

import { csi } from './csi.js'

export const DEC = {
  CURSOR_VISIBLE: 25,
  ALT_SCREEN: 47,
  ALT_SCREEN_CLEAR: 1049,
  MOUSE_NORMAL: 1000,
  MOUSE_BUTTON: 1002,
  MOUSE_ANY: 1003,
  MOUSE_SGR: 1006,
  FOCUS_EVENTS: 1004,
  ALTERNATE_SCROLL: 1007,
  BRACKETED_PASTE: 2004,
  SYNCHRONIZED_UPDATE: 2026,
} as const

export function decset(mode: number): string {
  return csi(`?${mode}h`)
}

export function decreset(mode: number): string {
  return csi(`?${mode}l`)
}

/** Begin / end synchronised update. */
export const BSU = decset(DEC.SYNCHRONIZED_UPDATE)
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE)
/** Enable / disable bracketed paste. */
export const EBP = decset(DEC.BRACKETED_PASTE)
export const DBP = decreset(DEC.BRACKETED_PASTE)
/** Enable / disable focus events. */
export const EFE = decset(DEC.FOCUS_EVENTS)
export const DFE = decreset(DEC.FOCUS_EVENTS)
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE)
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE)
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR)
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR)

export const ENABLE_MOUSE_TRACKING =
  decset(DEC.MOUSE_NORMAL) +
  decset(DEC.MOUSE_BUTTON) +
  decset(DEC.MOUSE_ANY) +
  decset(DEC.MOUSE_SGR)
/** The exact reverse order of the enable. */
export const DISABLE_MOUSE_TRACKING =
  decreset(DEC.MOUSE_SGR) +
  decreset(DEC.MOUSE_ANY) +
  decreset(DEC.MOUSE_BUTTON) +
  decreset(DEC.MOUSE_NORMAL)

export const ENABLE_ALTERNATE_SCROLL = decset(DEC.ALTERNATE_SCROLL)
export const DISABLE_ALTERNATE_SCROLL = decreset(DEC.ALTERNATE_SCROLL)
