import type { Chord, KeybindingBlock, ParsedBinding, ParsedKeystroke } from './types.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const MODIFIER_TOKENS: Record<string, keyof Omit<ParsedKeystroke, 'key'>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'super',
  command: 'super',
  super: 'super',
  win: 'super',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  '↑': 'up',
  '↓': 'down',
  '←': 'left',
  '→': 'right',
}

export function parseKeystroke(input: string): ParsedKeystroke {
  return notBuilt('src/keybindings/parser.ts:28')
}

export function parseChord(input: string): Chord {
  return notBuilt('src/keybindings/parser.ts:50')
}

const DISPLAY_NAMES: Record<string, string> = {
  escape: 'Esc',
  ' ': 'Space',
  tab: 'tab',
  enter: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
}

function displayKey(key: string): string {
  return DISPLAY_NAMES[key] ?? key
}

export function chordToString(chord: Chord): string {
  return notBuilt('src/keybindings/parser.ts:91')
}

export type DisplayPlatform = Unbuilt

export function chordToDisplayString(chord: Chord, platform?: DisplayPlatform): string {
  return notBuilt('src/keybindings/parser.ts:111')
}

export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  return notBuilt('src/keybindings/parser.ts:115')
}
