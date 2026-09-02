// Raw key event → normalised key name, and keystroke matching. Alt and meta
// are ONE logical modifier (terminals cannot tell them apart), super is
// distinct, and the escape key must have its meta flag forced off before
// comparison — the event layer sets meta whenever escape is pressed.

import type { Key } from '../ink/events/input-event.js'
import type { ParsedBinding, ParsedKeystroke } from './types.js'

const NAMED_FLAGS: ReadonlyArray<[keyof Key, string]> = [
  ['escape', 'escape'],
  ['return', 'enter'],
  ['tab', 'tab'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['upArrow', 'up'],
  ['downArrow', 'down'],
  ['leftArrow', 'left'],
  ['rightArrow', 'right'],
  ['pageUp', 'pageup'],
  ['pageDown', 'pagedown'],
  ['wheelUp', 'wheelup'],
  ['wheelDown', 'wheeldown'],
  ['home', 'home'],
  ['end', 'end'],
]

/** The normalised key name, or null when the event names nothing a binding
 *  could match (multi-character input such as a paste). */
export function getKeyName(input: string, key: Key): string | null {
  for (const [flag, name] of NAMED_FLAGS) {
    if (key[flag]) return name
  }
  if (input.length === 1) return input.toLowerCase()
  // A HELD key coalesces into one nameless run ('jjjj') under read
  // batching (the decoder's own header records it), so every single-letter
  // binding went dead the moment the operator held its key — Settings
  // j/k/r, Select j/k (TASK-017 supplement, SURVIVED S2; REPL's
  // per-character pager loop was written for this exact shape and its own
  // equality guard kept it unreachable). A UNIFORM printable run names its
  // letter: the binding fires once per read batch — one atom, one step —
  // which is motion instead of deadness. Mixed runs (real paste bodies)
  // stay nameless.
  if (input.length > 1) {
    const ch = input[0]!
    if (ch >= ' ' && ch !== '\x7f' && input === ch.repeat(input.length)) return ch.toLowerCase()
  }
  return null
}

export function matchesKeystroke(input: string, key: Key, target: ParsedKeystroke): boolean {
  const name = getKeyName(input, key)
  if (name === null || name !== target.key) return false
  // The escape quirk: escape always carries meta from the event layer.
  const meta = name === 'escape' ? false : key.meta
  if (key.ctrl !== target.ctrl) return false
  if (key.shift !== target.shift) return false
  if (key.super !== target.super) return false
  return meta === (target.alt || target.meta)
}

export function matchesBinding(input: string, key: Key, binding: ParsedBinding): boolean {
  if (binding.chord.length !== 1) return false
  return matchesKeystroke(input, key, binding.chord[0]!)
}
