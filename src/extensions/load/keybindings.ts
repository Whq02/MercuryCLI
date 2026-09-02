import { existsSync, readFileSync } from 'node:fs'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import { getKeybindingsPath, getProjectKeybindingsPath } from '../../keybindings/loadUserBindings.js'
import { chordToString, parseChord } from '../../keybindings/parser.js'
import type { KeybindingBlock } from '../../keybindings/types.js'
import { activeFor } from '../active.js'

function canonical(chord: string): string | null {
  try {
    return chordToString(parseChord(chord))
  } catch {
    return null
  }
}

function chordsIn(blocks: KeybindingBlock[]): Set<string> {
  const out = new Set<string>()
  for (const block of blocks) {
    for (const [chord, value] of Object.entries(block.bindings)) {
      if (value === null) continue
      const key = canonical(chord)
      if (key) out.add(key)
    }
  }
  return out
}

function operatorBlocks(): KeybindingBlock[] {
  const blocks: KeybindingBlock[] = []
  for (const path of [getKeybindingsPath(), getProjectKeybindingsPath()]) {
    if (!path || !existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { bindings?: unknown }
      if (Array.isArray(parsed.bindings)) {
        for (const block of parsed.bindings) {
          if (block && typeof block === 'object' && typeof (block as KeybindingBlock).context === 'string' && (block as KeybindingBlock).bindings) blocks.push(block as KeybindingBlock)
        }
      }
    } catch {
    }
  }
  return blocks
}

export function boundChords(): Set<string> {
  const taken = chordsIn(DEFAULT_BINDINGS)
  for (const chord of chordsIn(operatorBlocks())) taken.add(chord)
  return taken
}

export function isChordTaken(chord: string): boolean {
  const key = canonical(chord)
  if (!key) return true
  return boundChords().has(key)
}

export function getExtensionKeybindingBlocks(): KeybindingBlock[] {
  const taken = boundChords()
  const blocks: KeybindingBlock[] = []
  for (const ext of activeFor('keybindings')) {
    const bindings: Record<string, string> = {}
    for (const binding of ext.resolution.keybindings) {
      const key = canonical(binding.chord)
      if (!key || taken.has(key)) continue
      bindings[binding.chord] = `command:${binding.target.replace(/^\//, '')}`
      taken.add(key)
    }
    if (Object.keys(bindings).length > 0) blocks.push({ context: 'Chat', bindings })
  }
  return blocks
}
