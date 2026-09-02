import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { getKeybindingsPath, getProjectKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import { chordToString, parseChord } from '../../keybindings/parser.js'
import type { Chord } from '../../keybindings/types.js'

const DEFAULT_CHARS: ReadonlyArray<readonly [string, string]> = [
  ['extensions:toggle', ' '],
  ['extensions:install', 'i'],
  ['extensions:update', 'U'],
  ['extensions:remove', 'x'],
  ['extensions:block', 'b'],
  ['extensions:options', 'o'],
  ['extensions:add-source', 'a'],
  ['extensions:refresh', 'u'],
  ['extensions:reload', 'r'],
  ['extensions:filter', 'f'],
  ['extensions:previous', 'P'],
]

export type ExtensionsBindings = {
  chars: Map<string, string>
  declined: string[]
}

export function charWord(char: string): string {
  return char === ' ' ? 'space' : char
}

export function resolveExtensionsBindings(): ExtensionsBindings {
  const chars = new Map<string, string>(DEFAULT_CHARS)
  const declined: string[] = []
  const file = getKeybindingsPath()
  const limit = `the extensions board arms single keys — rebind it in ${basename(file)} under ${dirname(file)}`

  const stored: Array<{ pattern: string; chord: Chord; action: string | null }> = []
  for (const path of [file, getProjectKeybindingsPath()]) {
    if (!path) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bindings?: Array<{ context?: string; bindings?: Record<string, string | null> }> }
      for (const block of parsed.bindings ?? []) {
        if (block?.context !== 'Extensions' || !block.bindings) continue
        for (const [pattern, action] of Object.entries(block.bindings)) {
          stored.push({ pattern, chord: parseChord(pattern), action: typeof action === 'string' ? action : null })
        }
      }
    } catch {
    }
  }

  const plainCharOf = (pattern: string, ks: Chord[number]): string | null => {
    if (ks.ctrl || ks.alt || ks.meta || ks.super) return null
    if (ks.key === 'space' || ks.key === ' ') return ' '
    if (pattern.length === 1) return pattern
    if (ks.key.length !== 1) return null
    return ks.shift ? ks.key.toUpperCase() : ks.key
  }

  for (const binding of stored) {
    const action = binding.action
    const chord = binding.chord

    if (action === null) {
      const char = chord.length === 1 ? plainCharOf(binding.pattern, chord[0]!) : null
      if (char !== null) {
        for (const [held, heldChar] of chars) {
          if (heldChar === char) {
            chars.delete(held)
            declined.push(`${held} was unbound (${chordToString(chord)} → null) — bind a single key in ${file} to use it here`)
          }
        }
      }
      continue
    }
    if (!action.startsWith('extensions:')) continue

    const char = chord.length === 1 ? plainCharOf(binding.pattern, chord[0]!) : null
    if (char === null) {
      chars.delete(action)
      declined.push(`${action} is bound to '${chordToString(chord)}' — ${limit}`)
      continue
    }
    for (const [held, heldChar] of chars) {
      if (held !== action && heldChar === char) {
        chars.delete(held)
        declined.push(`${held} lost '${charWord(char)}' to ${action} — ${limit}`)
      }
    }
    chars.set(action, char)
  }

  return { chars, declined }
}
