// React lookups for an action's display chord and its honest reachability.

import { getPlatform } from '../utils/platform.js'
import { actionAffordance, type ActionAffordance } from './atlas.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

/** The resolved display chord, or the fallback in the pre-provider window
 *  (dialog launchers and boot chrome mount before the provider). */
export function useShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  const keybindings = useOptionalKeybindingContext()
  if (!keybindings) return fallback
  return keybindings.getDisplayText(action, context) ?? fallback
}

/** The honest form: reachable or not, with what chord, and why not. */
export function useActionAffordance(action: string, context: KeybindingContextName): ActionAffordance {
  const keybindings = useOptionalKeybindingContext()
  if (!keybindings) {
    return { kind: 'unbound', reason: 'keybindings have not loaded yet' }
  }
  return actionAffordance(action, context, keybindings.bindings, getPlatform())
}
