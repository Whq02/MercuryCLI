import type { Key } from '../ink/events/input-event.js'
import { getKeyName, matchesBinding } from './match.js'
import { chordToDisplayString, chordToString, type DisplayPlatform } from './parser.js'
import type { KeybindingContextName, ParsedBinding, ParsedKeystroke } from './types.js'

export type ResolveResult = { type: 'match'; action: string } | { type: 'none' } | { type: 'unbound' }
export type ChordResolveResult = ResolveResult | { type: 'chord_cancelled' } | { type: 'chord_started'; pending: ParsedKeystroke[] }

function chordOf(input: string, key: Key, pending: ParsedKeystroke[] | null): ParsedKeystroke[] | null {
  const name = getKeyName(input, key)
  if (name === null) return null
  const alt = name !== 'escape' && key.meta
  return [...pending ?? [], { key: name, ctrl: key.ctrl, alt, shift: key.shift, meta: alt, super: key.super }]
}

function startsWithChord(chord: ParsedKeystroke[], prefix: ParsedKeystroke[]): boolean {
  return chord.length >= prefix.length && prefix.every((a, i) => {
    const b = chord[i]!
    return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.super === b.super && (a.alt || a.meta) === (b.alt || b.meta)
  })
}

function decision(binding: ParsedBinding): ResolveResult {
  return binding.action === null ? { type: 'unbound' } : { type: 'match', action: binding.action }
}

export function resolveKey(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  const binding = bindings.findLast(b => activeContexts.includes(b.context) && matchesBinding(input, key, b))
  return binding ? decision(binding) : { type: 'none' }
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
  const chord = chordOf(input, key, pending)
  const miss = inChord ? 'chord_cancelled' : 'none'
  if (!chord) return { type: miss }
  let exact: ParsedBinding | undefined
  const longer = new Set<string>()
  for (const binding of bindings) {
    if (!activeContexts.includes(binding.context) || !startsWithChord(binding.chord, chord)) continue
    if (binding.chord.length === chord.length) exact = binding
    else {
      const spelling = chordToString(binding.chord)
      if (binding.action === null) longer.delete(spelling)
      else longer.add(spelling)
    }
  }
  if (longer.size) return { type: 'chord_started', pending: chord }
  return exact ? decision(exact) : { type: miss }
}

export function unboundConsumes(input: string, key: Key): boolean {
  return key.ctrl || key.meta || input === '' || /[\x00-\x1f\x7f]/.test(input)
}

export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
  platform?: DisplayPlatform,
): string | undefined {
  const binding = bindings.findLast(b => b.action === action && b.context === context)
  return binding ? chordToDisplayString(binding.chord, platform) : undefined
}

export function matchingBindings(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending?: ParsedKeystroke[] | null,
): ParsedBinding[] {
  const chord = chordOf(input, key, pending ?? null)
  if (!chord) return []
  return bindings.filter(b => activeContexts.includes(b.context) && b.chord.length === chord.length && startsWithChord(b.chord, chord))
}
