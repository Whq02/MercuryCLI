import type { Key } from '../ink/events/input-event.js'
import type { ParsedBinding, ParsedKeystroke } from './types.js'
import { notBuilt } from '../pi/holes.js'

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
  return notBuilt('src/keybindings/match.ts:23')
}

export function matchesKeystroke(input: string, key: Key, target: ParsedKeystroke): boolean {
  return notBuilt('src/keybindings/match.ts:35')
}

export function matchesBinding(input: string, key: Key, binding: ParsedBinding): boolean {
  return notBuilt('src/keybindings/match.ts:45')
}
