import type { KeybindingContextName } from './types.js'
import { notBuilt } from '../pi/holes.js'

export function getShortcutDisplay(
  action: string,
  context: KeybindingContextName,
  fallback: string,
): string {
  return notBuilt('src/keybindings/shortcutFormat.ts:7')
}
