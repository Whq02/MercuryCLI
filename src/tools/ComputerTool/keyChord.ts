import { isDesktopKey, type DesktopModifier } from '../../services/desktop/driver.js'

export interface KeyChord {
  key: string
  modifiers: DesktopModifier[]
}

export interface KeyChordRefusal {
  refused: true
  reason: string
}

export const KEY_CHORD_VOCABULARY =
  'Enter, Escape, Tab, Space, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, F1–F12 or one character, with cmd/ctrl/alt/shift joined by +'

const MODIFIER_WORDS: Readonly<Record<string, DesktopModifier>> = {
  cmd: 'super',
  command: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
  super: 'super',
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: 'enter',
  return: 'enter',
  tab: 'tab',
  escape: 'escape',
  esc: 'escape',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  space: 'space',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  f1: 'f1',
  f2: 'f2',
  f3: 'f3',
  f4: 'f4',
  f5: 'f5',
  f6: 'f6',
  f7: 'f7',
  f8: 'f8',
  f9: 'f9',
  f10: 'f10',
  f11: 'f11',
  f12: 'f12',
}

export function isKeyChordRefusal(value: KeyChord | KeyChordRefusal): value is KeyChordRefusal {
  return 'refused' in value && value.refused === true
}

function refusal(reason: string): KeyChordRefusal {
  return { refused: true, reason }
}

function splitChord(text: string): string[] {
  const parts = text.split('+')
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    return [...parts.slice(0, -2), '+']
  }
  return parts
}

function driverKeyOf(word: string, modifiers: DesktopModifier[]): string | KeyChordRefusal {
  const lower = word.toLowerCase()
  const named = NAMED_KEYS[lower]
  if (named !== undefined) return named
  const modifier = MODIFIER_WORDS[lower]
  if (modifier !== undefined) return modifier
  if ([...word].length !== 1) {
    return refusal(`"${word}" is not a key — one chord takes ${KEY_CHORD_VOCABULARY}`)
  }
  if (word !== lower && word.toUpperCase() === word && /[A-Z]/.test(word)) {
    if (!modifiers.includes('shift')) modifiers.push('shift')
    return lower
  }
  if (!isDesktopKey(word)) {
    return refusal(`"${word}" is not a key the desktop driver can press — type it as text instead`)
  }
  return word
}

export function parseKeyChord(text: string): KeyChord | KeyChordRefusal {
  const trimmed = text.trim()
  if (trimmed === '') return refusal(`the chord is empty — one chord takes ${KEY_CHORD_VOCABULARY}`)
  const parts = splitChord(trimmed).map(part => part.trim())
  const modifiers: DesktopModifier[] = []
  for (const part of parts.slice(0, -1)) {
    if (part === '') return refusal(`"${trimmed}" has an empty part — join the keys with a single +`)
    const modifier = MODIFIER_WORDS[part.toLowerCase()]
    if (modifier === undefined) {
      return refusal(`"${part}" is not a modifier — a chord holds cmd, ctrl, alt or shift around ONE key (${trimmed})`)
    }
    if (!modifiers.includes(modifier)) modifiers.push(modifier)
  }
  const last = parts[parts.length - 1] ?? ''
  if (last === '') return refusal(`"${trimmed}" names no key after its modifiers`)
  const key = driverKeyOf(last, modifiers)
  if (typeof key !== 'string') return key
  return { key, modifiers }
}

export function sameKeyChord(a: KeyChord, b: KeyChord): boolean {
  if (a.key !== b.key || a.modifiers.length !== b.modifiers.length) return false
  return a.modifiers.every(modifier => b.modifiers.includes(modifier))
}

export function appSwitchChord(platform: string = process.platform): KeyChord {
  return platform === 'darwin' ? { key: 'tab', modifiers: ['super'] } : { key: 'tab', modifiers: ['alt'] }
}

export function isAppSwitchChord(chord: KeyChord, platform: string = process.platform): boolean {
  return sameKeyChord(chord, appSwitchChord(platform))
}
