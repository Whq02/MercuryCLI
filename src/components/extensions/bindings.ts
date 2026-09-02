// ============================================================================
//  src/components/extensions/bindings.ts — the board's ONE dispatch path
//  through the operator's keybindings (05 §2.3: "the operator may rebind").
//
//  The spec's default characters arm as written; a stored rebind in the
//  Extensions context REPLACES an action's character through the same
//  loader the /keys atlas edits (loadKeybindingsSync — user + project
//  layers). The chassis rowActions grammar stays the single dispatcher:
//  this module only decides WHICH character each action arms — no parallel
//  key hooks exist beside it (the one-dispatch-path ruling).
//
//  What the board cannot express it declines LOUDLY, never silently:
//  a chord (multi-keystroke or modifier) rebind, a key wider than one
//  character, an unbind, and a collision's displaced action each produce
//  one line naming the limit and the file — painted when the board opens.
//  Completing chord dispatch on the board is a named
//  follow-up.
// ============================================================================
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { getKeybindingsPath, getProjectKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import { chordToString, parseChord } from '../../keybindings/parser.js'
import type { Chord } from '../../keybindings/types.js'

/** The spec's defaults (05 §2.3), the exact characters the wireframes teach. */
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
  /** action → the armed character (`' '` = space). An action absent here is
   *  NOT armed on the board — its reason stands in `declined`. */
  chars: Map<string, string>
  /** One honest line per binding the board cannot arm. */
  declined: string[]
}

/** The spelling a footer hint uses for a character. */
export function charWord(char: string): string {
  return char === ' ' ? 'space' : char
}

/**
 * Resolve the Extensions context's effective single characters: defaults,
 * then the stored layers in order (later wins per action). Pure read — the
 * loader's own cwd-keyed cache makes it cheap per render.
 */
export function resolveExtensionsBindings(): ExtensionsBindings {
  const chars = new Map<string, string>(DEFAULT_CHARS)
  const declined: string[] = []
  const file = getKeybindingsPath()
  // The file's NAME leads its directory: a long home path sheds from the
  // right, and the line must still name the file it points at.
  const limit = `the extensions board arms single keys — rebind it in ${basename(file)} under ${dirname(file)}`

  // The OPERATOR's stored layers, read from the same files the /keys atlas
  // edits (user, then project — later wins). The assembled loader is not
  // usable here: it folds the parsed DEFAULTS into the same untagged array,
  // and their case-lossy parse ('U' → key 'u') would collide the spec's own
  // U/u pair. Defaults come from the table above instead.
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
      // An absent or unreadable layer is simply absent — the loader's own law.
    }
  }

  // The case law: the chord parser lowercases every token ('U' parses to the
  // key 'u'), which is right for the engine's shift-flagged events but would
  // read the spec's own `U` (update) as a collision with `u` (refresh). The
  // board compares typed characters directly, so a BARE single character
  // keeps the case the operator wrote; `shift+u` spells the same `U`.
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

    // An unbind (chord → null): the action holding that character loses it.
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
    // A collision displaces the character's previous holder — loudly.
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
