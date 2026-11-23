import { getPlatform } from '../../platform/environment/platform.js'
import { actionAffordance, type ActionAffordance } from './atlas.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  return useOptionalKeybindingContext()?.getDisplayText(action, context) ?? fallback
}

export function useActionAffordance(action: string, context: KeybindingContextName): ActionAffordance {
  const keys = useOptionalKeybindingContext()
  if (!keys) return { kind: 'unbound', reason: 'keybindings have not loaded yet' }
  return actionAffordance(action, context, keys.bindings, getPlatform())
}
