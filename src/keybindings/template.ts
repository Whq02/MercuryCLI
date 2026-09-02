
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
