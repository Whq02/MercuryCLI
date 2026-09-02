// Keystroke / chord grammar: parse `+`-separated tokens (case-insensitive,
// aliased) into keystroke records, whitespace-separated keystrokes into
// chords, and render both back canonically or platform-aware.

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
  const keystroke: ParsedKeystroke = {
    key: '',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
  }
  for (const rawToken of input.split('+')) {
    const token = rawToken.trim().toLowerCase()
    if (token === '') continue
    const modifier = MODIFIER_TOKENS[token]
    if (modifier) {
      keystroke[modifier] = true
      continue
    }
    // Several key tokens: the last one wins.
    keystroke.key = KEY_ALIASES[token] ?? token
  }
  return keystroke
}

/** Whitespace-separated keystrokes; a chord string that is EXACTLY one
 *  space is the space key, not a separator. */
export function parseChord(input: string): Chord {
  if (input === ' ') return [parseKeystroke('space')]
  return input
    .trim()
    .split(/\s+/)
    .filter(part => part !== '')
    .map(parseKeystroke)
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

/** Canonical rendering: ctrl, alt, shift, meta, super (as `cmd`), then the
 *  key. Used for comparison and display. */
export function keystrokeToString(ks: ParsedKeystroke): string {
  const parts: string[] = []
  if (ks.ctrl) parts.push('ctrl')
  if (ks.alt) parts.push('alt')
  if (ks.shift) parts.push('shift')
  if (ks.meta) parts.push('meta')
  if (ks.super) parts.push('cmd')
  parts.push(displayKey(ks.key))
  return parts.join('+')
}

export function chordToString(chord: Chord): string {
  return chord.map(keystrokeToString).join(' ')
}

export type DisplayPlatform = 'macos' | 'windows' | 'linux' | 'wsl' | 'unknown'

/** Platform-aware rendering for hints: alt and meta collapse into one
 *  modifier (`opt` on macOS, `alt` elsewhere), super renders `cmd` on macOS
 *  and `super` elsewhere; order ctrl, alt/meta, shift, super. */
export function keystrokeToDisplayString(
  ks: ParsedKeystroke,
  platform: DisplayPlatform = 'linux',
): string {
  const mac = platform === 'macos'
  const parts: string[] = []
  if (ks.ctrl) parts.push('ctrl')
  if (ks.alt || ks.meta) parts.push(mac ? 'opt' : 'alt')
  if (ks.shift) parts.push('shift')
  if (ks.super) parts.push(mac ? 'cmd' : 'super')
  parts.push(displayKey(ks.key))
  return parts.join('+')
}

export function chordToDisplayString(chord: Chord, platform: DisplayPlatform = 'linux'): string {
  return chord.map(ks => keystrokeToDisplayString(ks, platform)).join(' ')
}

/** Flatten blocks into bindings in declaration order — later entries win at
 *  resolution time, which is how user config overrides defaults. */
export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  const out: ParsedBinding[] = []
  for (const block of blocks) {
    for (const [pattern, value] of Object.entries(block.bindings)) {
      out.push({ chord: parseChord(pattern), action: value, context: block.context })
    }
  }
  return out
}
