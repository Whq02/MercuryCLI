// Pure key → action resolution: the simple resolver, the chord-aware
// resolver (prefix scan with null-override grouping, escape cancels), the
// shared unbind-consumption decision, the display lookup and the
// precedence read-back the atlas explains from.

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

/** Single-keystroke bindings only, active contexts only, LAST match wins. */
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

/** A keystroke record from an event, with the escape quirk corrected; null
 *  when no key name can be built. */
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

/** Equality collapses alt/meta exactly as matching does. */
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

  // 1. Escape cancels a chord — before any matching.
  if (inChord && key.escape) return { type: 'chord_cancelled' }

  // 2. A keystroke record, or nothing to match.
  const keystroke = buildKeystroke(input, key)
  if (!keystroke) return inChord ? { type: 'chord_cancelled' } : { type: 'none' }

  // 3. The chord under test.
  const test = inChord ? [...pending, keystroke] : [keystroke]

  // 4. Active contexts only.
  const active = new Set(activeContexts)
  const candidates = bindings.filter(b => active.has(b.context))

  // 5. Prefix scan, grouped by canonical chord string with the LAST value
  //    kept — a later null override shadows the default it unbinds.
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

  // 6. Longer chords win, even over an exact single-key match.
  if (hasLonger) return { type: 'chord_started', pending: test }

  // 7. Exact match, last one wins.
  let exact: ParsedBinding | undefined
  for (const binding of candidates) {
    if (chordsEqual(binding.chord, test)) exact = binding
  }
  if (exact) {
    if (exact.action === null) return { type: 'unbound' }
    return { type: 'match', action: exact.action }
  }

  // 8. Nothing.
  return inChord ? { type: 'chord_cancelled' } : { type: 'none' }
}

/**
 * When a keystroke resolves to explicitly-unbound, is it still consumed?
 * Disabling an action masks the ACTION, not ordinary typing: modifier
 * chords, control keys and named (empty-input) keys stay consumed so a
 * disabled modifier action never leaks its chord to a lower-priority
 * context; a printable passes through to the focused editor.
 */
export function unboundConsumes(input: string, key: Key): boolean {
  if (key.ctrl || key.meta) return true
  if (input === '') return true
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** The LAST binding of that action in that context, rendered in the
 *  platform DISPLAY dialect (alt/meta collapse to one modifier — the same
 *  renderer the atlas and palette use, so one chord never surfaces as
 *  'meta + p' in one hint and 'alt+p' in another); searching from the end
 *  is what makes user overrides win. The platform stays a parameter so
 *  this module remains pure. */
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

/** Every binding whose chord is exactly the pending prefix plus this
 *  keystroke, in resolver order — the last element is what resolution
 *  returns, the earlier ones are what it shadows. */
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
