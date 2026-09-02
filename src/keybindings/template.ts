// A starter keybindings.json from the defaults, minus every reserved chord
// (non-rebindable, terminal- and platform-owned — each would immediately
// produce a health finding) and minus the feature-gated contexts the user
// config's closed list refuses (Scroll, MessageActions): the file the
// product wrote failed the product's own validator — "2 keybinding errors
// and 5 keybinding warnings found" on a clean home (TASK-014 w2-f14-04).
// No `$schema`: the only published schema of that name describes another
// product's action vocabulary and would flag every Mercury action id.

import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { getReservedShortcuts, normalizeKeyForComparison } from './reservedShortcuts.js'
import type { KeybindingBlock } from './types.js'
import { isUserConfigContext } from './validate.js'
import { DOCS_LINE } from './writeBindings.js'

export function generateKeybindingsTemplate(): string {
  const reserved = new Set(getReservedShortcuts().map(entry => normalizeKeyForComparison(entry.key)))
  const bindings: KeybindingBlock[] = []
  for (const block of DEFAULT_BINDINGS) {
    if (!isUserConfigContext(block.context)) continue
    const kept: Record<string, string | null> = {}
    for (const [pattern, value] of Object.entries(block.bindings)) {
      if (reserved.has(normalizeKeyForComparison(pattern))) continue
      kept[pattern] = value
    }
    if (Object.keys(kept).length === 0) continue
    bindings.push({ context: block.context, bindings: kept })
  }
  const template = {
    $docs: DOCS_LINE,
    bindings,
  }
  return `${JSON.stringify(template, null, 2)}\n`
}
