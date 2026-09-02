
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

export function getKeyName(input: string, key: Key): string | null {
  for (const [flag, name] of NAMED_FLAGS) {
    if (key[flag]) return name
  }
  if (input.length === 1) return input.toLowerCase()
  if (input.length > 1) {
    const ch = input[0]!
    if (ch >= ' ' && ch !== '\x7f' && input === ch.repeat(input.length)) return ch.toLowerCase()
  }
  return null
}

export function matchesKeystroke(input: string, key: Key, target: ParsedKeystroke): boolean {
  const name = getKeyName(input, key)
  if (name === null || name !== target.key) return false
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
