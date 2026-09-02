// ============================================================================
//  utils/cockpit/composerSeed — type-through on the tool-permission card
//
//
//  The one-way half of the composer/consent dance already exists: typing in
//  the composer suppresses a pending permission card (REPL's
//  isPromptInputActive gate over getFocusedInputDialog). This store adds the
//  REVERSE entry: while the consent card is focused (the composer is
//  unmounted), a printable NON-DIGIT key seeds the composer draft through
//  REPL's setInputValue — the same chokepoint a real keystroke rides — so
//  isPromptInputActive flips, the card yields, and the operator just keeps
//  typing their next message. Digits stay Select hotkeys (1/2/3 answer the
//  card); the numeric branch in use-select-input returns before this seam.
//
//  Shape rules: a module store with explicit ARM — the CustomSelect grammar
//  is estate-wide, so the fall-through only seeds while a PermissionRequest
//  is actually mounted (armComposerSeed pairs with its unmount, counted —
//  queued consent cards can overlap mount/unmount). The seeder is REPL's
//  setInputValue-append, registered once per REPL mount. No React state
//  here: the seed writes REPL state; nothing subscribes to this store.
// ============================================================================

import type { Key } from '../../ink.js'

let armed = 0
let seeder: ((seed: string) => void) | null = null

/** REPL registers its composer-draft appender (setInputValue-based). */
export function registerComposerSeeder(fn: (seed: string) => void): () => void {
  seeder = fn
  return () => {
    if (seeder === fn) seeder = null
  }
}

/** The tool-permission card arms the seam while mounted. Counted, and each
 *  disarm is idempotent — React StrictMode double-invokes effects. */
export function armComposerSeed(): () => void {
  armed++
  let released = false
  return () => {
    if (released) return
    released = true
    armed = Math.max(0, armed - 1)
  }
}

/** True only for input that reads as the START of a typed message: printable,
 *  not pure digits (Select hotkeys), not pure whitespace (a leading space
 *  would not flip isPromptInputActive — value.trim() gates it). */
export function isSeedableInput(input: string, key: Key): boolean {
  if (!input || input.trim().length === 0) return false
  if (key.ctrl || key.meta || key.super || key.escape || key.return || key.tab) return false
  if (key.backspace || key.delete) return false
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return false
  if (key.pageUp || key.pageDown || key.home || key.end) return false
  if (key.wheelUp || key.wheelDown) return false
  if (/^[0-9]+$/.test(input)) return false
  // Raw control bytes (an ESC sequence that slipped the parser) never seed.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) return false
  return true
}

/** Direct composer hand-off for surfaces that legitimately stage a
 *  ready-to-edit draft on an EXPLICIT operator activation (the /help
 *  command insert — P6 "no dead Enter"). Skips the consent-card arm
 *  (the activation itself is the consent); rides the same REPL
 *  setInputValue-append chokepoint, so it is exactly as safe as typing.
 *  Returns false when no composer is mounted to receive the seed. */
export function seedComposerDirect(text: string): boolean {
  if (!seeder || !text) return false
  seeder(text)
  return true
}

/** The use-select-input fall-through: seed the composer if the permission
 *  seam is armed and the key reads as typed text. Returns true when consumed. */
export function trySeedComposer(input: string, key: Key): boolean {
  if (armed <= 0 || !seeder) return false
  if (!isSeedableInput(input, key)) return false
  seeder(input)
  return true
}

/** Test seam. */
export function __composerSeedResetForTest(): void {
  armed = 0
  seeder = null
}
