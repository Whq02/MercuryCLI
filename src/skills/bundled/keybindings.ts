import { registerBundledSkill } from '../bundledSkills.js'
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
  KEYBINDING_CONTEXT_DESCRIPTIONS,
} from '../../keybindings/schema.js'
import type { KeybindingsSchemaType } from '../../keybindings/schema.js'
import { DEFAULT_BINDINGS } from '../../keybindings/defaultBindings.js'
import {
  NON_REBINDABLE,
  TERMINAL_RESERVED,
  MACOS_RESERVED,
  WINDOWS_RESERVED,
} from '../../keybindings/reservedShortcuts.js'
import { isKeybindingCustomizationEnabled } from '../../keybindings/loadUserBindings.js'
import { ACTION_GRAPH, type ActionMeta } from '../../keybindings/actionGraph.js'
import { DOCS_LINE } from '../../keybindings/writeBindings.js'
import { notBuilt } from '../../pi/holes.js'

export function registerKeybindingsSkill(): void {
  return notBuilt('src/skills/bundled/keybindings.ts:83')
}
