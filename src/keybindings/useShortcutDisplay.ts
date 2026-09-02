
import { getPlatform } from '../utils/platform.js'
import { actionAffordance, type ActionAffordance } from './atlas.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const keybindings = useOptionalKeybindingContext()
  if (!keybindings) return fallback
  return keybindings.getDisplayText(action, context) ?? fallback
}

export function useActionAffordance(action: string, context: KeybindingContextName): ActionAffordance {
  const keybindings = useOptionalKeybindingContext()
  if (!keybindings) {
    return { kind: 'unbound', reason: 'keybindings have not loaded yet' }
  }
  return actionAffordance(action, context, keybindings.bindings, getPlatform())
}
