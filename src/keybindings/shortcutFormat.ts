
import { getPlatform } from '../utils/platform.js'
import { loadKeybindingsSync } from './loadUserBindings.js'
import { getBindingDisplayText } from './resolver.js'
import type { KeybindingContextName } from './types.js'

export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  return getBindingDisplayText(action, context, loadKeybindingsSync(), getPlatform()) ?? fallback
}
