import type { ActionAffordance } from './atlas.js'
import type { KeybindingContextName } from './types.js'
import { notBuilt } from '../pi/holes.js'

export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  return notBuilt('src/keybindings/useShortcutDisplay.ts:7')
}

export function useActionAffordance(action: string, context: KeybindingContextName): ActionAffordance {
  return notBuilt('src/keybindings/useShortcutDisplay.ts:17')
}
