// ============================================================================
//  screen-session.ts — T6 (the T5 arming re-scope): the
//  terminal-mode ARMING composites as pure byte builders.
//
//  Every place the session arms, re-arms, or hands over terminal modes —
//  the editor handoff, the SIGCONT/stall alt re-entry, the resize re-assert,
//  the stdin-gap mode re-assert, App's raw-mode-entry arming — builds
//  its escape string here, never inline. Each composite is ONE
//  pure builder: same bytes, same ORDER (LAW PAUSE/EDITOR +
//  LAW SESSION-TRACE pin them), option-matrix testable without a terminal.
//
//  Ordering rationale (load-bearing, from the shipped composites):
//  • enterEditor disables kitty/modifyOtherKeys FIRST — editors that don't
//    speak CSI-u (nano) show "Unknown sequence" for every Ctrl-<key> if
//    extended reporting stays active.
//  • exitEditor re-enters alt when the session owns it — vim's rmcup dropped
//    us to main; without the re-enter the 2J wipes main-screen scrollback.
//    Fullscreen writes NO eager 2J/H (the erase folds into the next composed
//    frame's atomic write); non-fullscreen still clears the abandoned alt
//    buffer before dropping back to main.
//  • Kitty re-enable is always POP-BEFORE-PUSH — CSI >1u is a stack push;
//    without the pop each editor round-trip / idle gap accumulates depth and
//    the single pop on exit can't drain it (Ctrl+C leaks as CSI-u to the
//    shell).
//  • reenterAlt resets scroll margins (DECSTBM) — CSI ?1049h does NOT clear
//    them and a stale margin scrolls the alt screen out from under the
//    writer.
// ============================================================================
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

/** The kitty-safe extended-keys re-enable: pop-before-push (see header). */
export function extendedKeysReenable(extendedKeys: boolean): string {
  return extendedKeys ? DISABLE_KITTY_KEYBOARD + ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS : ''
}

/** Editor handoff — hand the terminal to an external TUI (git editor,
 *  nano). Extended keys off FIRST; alt entered only when not already
 *  owned; focus reporting off; attributes reset; cursor shown for the
 *  editor; clear + home. */
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

/** Editor return, part 1 (before stdin resume + repaint): re-enter alt when
 *  the session owns it (vim's rmcup dropped us to main) or clear the
 *  abandoned alt buffer and drop back; mouse/scroll re-armed; cursor back
 *  to Ink's management. */
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

/** Editor return, part 2 (after resume): focus reporting + extended keys
 *  back — editors reset modifyOtherKeys on exit. */
export function exitEditorRearmBytes(extendedKeys: boolean): string {
  return EFE + extendedKeysReenable(extendedKeys)
}

/** SIGCONT / stall-detector alt re-entry — destructive (ERASE_SCREEN);
 *  margins reset because ?1049h does not clear DECSTBM. */
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

/** Sleep/wake re-entry — the PAIRED form (TASK-017 S2,
 *  stall-wake-re-enter-clobbers-exit-cursor): a bare repeat ?1049h on an
 *  ACTIVE alt screen re-runs the DEC 1049 cursor SAVE with the alt
 *  cursor's position, clobbering the main-screen position the single exit
 *  ?1049l later restores — the shell prompt and the resume hint landed
 *  mid-scrollback — and iTerm2 treats a repeat enter as a buffer clear
 *  (AlternateScreen's own law). Exit-then-enter keeps the save/restore
 *  slot TRUE on a terminal that kept the alt screen (the restore runs at
 *  the old position, the fresh save records it again) and is a plain
 *  fresh enter on one that silently dropped to the main screen — both
 *  wake shapes healed by one composite. */
export function wakeReenterAltBytes(mouseTracking: boolean): string {
  return EXIT_ALT_SCREEN + reenterAltBytes(mouseTracking)
}

/** Resize re-assert (alt only) — some emulators reset private modes on
 *  resize; both are idempotent. */
export function resizeReassertBytes(mouseTracking: boolean): string {
  return (mouseTracking ? ENABLE_MOUSE_TRACKING : '') + ENABLE_ALTERNATE_SCROLL
}

/** Raw-mode ENTRY arming (App, first enable): bracketed paste + focus
 *  reporting + extended keys — kitty stack push AND xterm modifyOtherKeys
 *  level 2, terminals honor whichever they implement (tmux only the
 *  latter); allowlisted terminals only, the caller sniffs. */
export function rawModeArmBytes(extendedKeys: boolean): string {
  return EBP + EFE + (extendedKeys ? ENABLE_KITTY_KEYBOARD + ENABLE_MODIFY_OTHER_KEYS : '')
}

/** Raw-mode EXIT disarm (App, last disable): the reverse suite. */
export function rawModeDisarmBytes(): string {
  return DISABLE_MODIFY_OTHER_KEYS + DISABLE_KITTY_KEYBOARD + DFE + DBP
}

/** Stdin-gap / stall mode re-assert (the non-destructive part): extended
 *  keys pop-before-push; bracketed paste + focus reporting (both armed at
 *  raw-mode entry, both idempotent h-writes — their old absence here was
 *  the asymmetry behind the windows-tasks T4 finding: the heal restored
 *  the mouse family while the 1004/2004 pair stayed wherever the terminal
 *  reset left them); alt-only mouse + scroll. The destructive alt re-entry
 *  stays a separate opt-in (reenterAltBytes). */
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
