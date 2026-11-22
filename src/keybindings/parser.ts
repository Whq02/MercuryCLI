import type { Chord, KeybindingBlock, ParsedBinding, ParsedKeystroke } from './types.js'

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
  const stroke: ParsedKeystroke = { key: '', ctrl: false, alt: false, shift: false, meta: false, super: false }
  for (const part of input.split('+')) {
    const token = part.trim().toLowerCase()
    if (!token) continue
    if (Object.hasOwn(MODIFIER_TOKENS, token)) stroke[MODIFIER_TOKENS[token]!] = true
    else stroke.key = Object.hasOwn(KEY_ALIASES, token) ? KEY_ALIASES[token]! : token
  }
  return stroke
}

export function parseChord(input: string): Chord {
  if (input === ' ') return [parseKeystroke('space')]
  const text = input.trim()
  return text === '' ? [] : text.split(/\s+/).map(parseKeystroke)
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

export type DisplayPlatform = 'linux' | 'macos' | 'unknown' | 'windows' | 'wsl'

function spellStroke(stroke: ParsedKeystroke, platform?: DisplayPlatform): string {
  const parts: string[] = []
  if (stroke.ctrl) parts.push('ctrl')
  if (stroke.alt || (platform !== undefined && stroke.meta)) parts.push(platform === 'macos' ? 'opt' : 'alt')
  if (stroke.shift) parts.push('shift')
  if (platform === undefined && stroke.meta) parts.push('meta')
  if (stroke.super) parts.push(platform === undefined || platform === 'macos' ? 'cmd' : 'super')
  parts.push(displayKey(stroke.key))
  return parts.join('+')
}

export function chordToString(chord: Chord): string {
  return chord.map(stroke => spellStroke(stroke)).join(' ')
}

export function chordToDisplayString(chord: Chord, platform: DisplayPlatform = 'linux'): string {
  return chord.map(stroke => spellStroke(stroke, platform)).join(' ')
}

export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  return blocks.flatMap(({ context, bindings }) =>
    Object.entries(bindings).map(([pattern, action]) => ({ chord: parseChord(pattern), action, context })),
  )
}
