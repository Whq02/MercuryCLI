import {
  CURSOR_HOME,
  DISABLE_KITTY_KEYBOARD,
  DISABLE_MODIFY_OTHER_KEYS,
  ENABLE_KITTY_KEYBOARD,
  ENABLE_MODIFY_OTHER_KEYS,
  ERASE_SCREEN,
  RESET_SCROLL_REGION,
} from '../termio/csi.js'
import {
  DBP,
  DFE,
  DISABLE_ALTERNATE_SCROLL,
  DISABLE_MOUSE_TRACKING,
  EBP,
  EFE,
  ENABLE_ALTERNATE_SCROLL,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from '../termio/dec.js'

const SGR_RESET = '\u001b[0m'
const CURSOR_SHOW = '\u001b[?25h'
const CURSOR_HIDE = '\u001b[?25l'

export function extendedKeysReenable(extendedKeys: boolean): string {
  return extendedKeys ? DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS : ''
}

export function enterEditorBytes(opts: { altActive: boolean; mouseTracking: boolean }): string {
  return (
    DISABLE_KITTY_KEYBOARD +
    DISABLE_MODIFY_OTHER_KEYS +
    DISABLE_ALTERNATE_SCROLL +
    (opts.mouseTracking ? DISABLE_MOUSE_TRACKING : '') +
    (opts.altActive ? '' : ENTER_ALT_SCREEN) +
    DFE +
    SGR_RESET +
    CURSOR_SHOW +
    ERASE_SCREEN +
    CURSOR_HOME
  )
}

export function exitEditorBytes(opts: { altActive: boolean; mouseTracking: boolean }): string {
  return (
    (opts.altActive ? ENTER_ALT_SCREEN : '') +
    (opts.altActive ? '' : ERASE_SCREEN + CURSOR_HOME) +
    (opts.mouseTracking ? ENABLE_MOUSE_TRACKING : '') +
    (opts.altActive ? ENABLE_ALTERNATE_SCROLL : '') +
    (opts.altActive ? '' : EXIT_ALT_SCREEN) +
    CURSOR_HIDE
  )
}

export function exitEditorRearmBytes(extendedKeys: boolean): string {
  return EFE + extendedKeysReenable(extendedKeys)
}

export function reenterAltBytes(mouseTracking: boolean): string {
  return (
    ENTER_ALT_SCREEN +
    RESET_SCROLL_REGION +
    ERASE_SCREEN +
    CURSOR_HOME +
    (mouseTracking ? ENABLE_MOUSE_TRACKING : '') +
    ENABLE_ALTERNATE_SCROLL
  )
}

export function wakeReenterAltBytes(mouseTracking: boolean): string {
  return EXIT_ALT_SCREEN + reenterAltBytes(mouseTracking)
}

export function resizeReassertBytes(mouseTracking: boolean): string {
  return (mouseTracking ? ENABLE_MOUSE_TRACKING : '') + ENABLE_ALTERNATE_SCROLL
}

export function rawModeArmBytes(extendedKeys: boolean): string {
  return EBP + EFE + (extendedKeys ? ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS : '')
}

export function rawModeDisarmBytes(): string {
  return DISABLE_MODIFY_OTHER_KEYS + DISABLE_KITTY_KEYBOARD + DFE + DBP
}

export function reassertModesBytes(opts: {
  extendedKeys: boolean
  altActive: boolean
  mouseTracking: boolean
}): string {
  return (
    extendedKeysReenable(opts.extendedKeys) +
    EBP +
    EFE +
    (opts.altActive && opts.mouseTracking ? ENABLE_MOUSE_TRACKING : '') +
    (opts.altActive ? ENABLE_ALTERNATE_SCROLL : '')
  )
}
