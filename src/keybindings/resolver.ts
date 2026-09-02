
import type { Key } from '../ink/events/input-event.js'
import { getKeyName, matchesBinding } from './match.js'
import { chordToDisplayString, chordToString, type DisplayPlatform } from './parser.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'

export type ResolveResult =
  | { type: 'match'; action: string }
  | { type: 'none' }
  | { type: 'unbound' }

export type ChordResolveResult =
  | ResolveResult
  | { type: 'chord_started'; pending: ParsedKeystroke[] }
  | { type: 'chord_cancelled' }

export function resolveKey(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  const active = new Set(activeContexts)
  let found: ParsedBinding | undefined
  for (const binding of bindings) {
    if (!active.has(binding.context)) continue
    if (matchesBinding(input, key, binding)) found = binding
  }
  if (!found) return { type: 'none' }
  if (found.action === null) return { type: 'unbound' }
  return { type: 'match', action: found.action }
}

function buildKeystroke(input: string, key: Key): ParsedKeystroke | null {
  const name = getKeyName(input, key)
  if (name === null) return null
  const meta = name === 'escape' ? false : key.meta
  return {
    key: name,
    ctrl: key.ctrl,
    alt: meta,
    shift: key.shift,
    meta,
    super: key.super,
  }
}

export function keystrokesEqual(a: ParsedKeystroke, b: ParsedKeystroke): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    a.super === b.super &&
    (a.alt || a.meta) === (b.alt || b.meta)
  )
}

function chordsEqual(a: ParsedKeystroke[], b: ParsedKeystroke[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!keystrokesEqual(a[i]!, b[i]!)) return false
  }
  return true
}

function isPrefixOf(prefix: ParsedKeystroke[], chord: ParsedKeystroke[]): boolean {
  if (chord.length <= prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (!keystrokesEqual(prefix[i]!, chord[i]!)) return false
  }
  return true
}

export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  const inChord = pending !== null && pending.length > 0

  if (inChord && key.escape) return { type: 'chord_cancelled' }

  const keystroke = buildKeystroke(input, key)
  if (!keystroke) return inChord ? { type: 'chord_cancelled' } : { type: 'none' }

  const test = inChord ? [...pending, keystroke] : [keystroke]

  const active = new Set(activeContexts)
  const candidates = bindings.filter(b => active.has(b.context))

  const longer = new Map<string, string | null>()
  for (const binding of candidates) {
    if (isPrefixOf(test, binding.chord)) {
      longer.set(chordToString(binding.chord), binding.action)
    }
  }
  let hasLonger = false
  for (const value of longer.values()) {
    if (value !== null) {
      hasLonger = true
      break
    }
  }

  if (hasLonger) return { type: 'chord_started', pending: test }

  let exact: ParsedBinding | undefined
  for (const binding of candidates) {
    if (chordsEqual(binding.chord, test)) exact = binding
  }
  if (exact) {
    if (exact.action === null) return { type: 'unbound' }
    return { type: 'match', action: exact.action }
  }

  return inChord ? { type: 'chord_cancelled' } : { type: 'none' }
}

export function unboundConsumes(input: string, key: Key): boolean {
  if (key.ctrl || key.meta) return true
  if (input === '') return true
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
  platform: DisplayPlatform = 'linux',
): string | undefined {
  for (let i = bindings.length - 1; i >= 0; i--) {
    const binding = bindings[i]!
    if (binding.action === action && binding.context === context) {
      return chordToDisplayString(binding.chord, platform)
    }
  }
  return undefined
}

export function matchingBindings(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null = null,
): ParsedBinding[] {
  const keystroke = buildKeystroke(input, key)
  if (!keystroke) return []
  const test = pending && pending.length > 0 ? [...pending, keystroke] : [keystroke]
  const active = new Set(activeContexts)
  return bindings.filter(b => active.has(b.context) && chordsEqual(b.chord, test))
}
