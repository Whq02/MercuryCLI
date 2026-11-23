
import { getPlatform, type Platform } from '../../platform/environment/platform.js'

export function keyHintLabel(hint: string, platform: Platform = getPlatform()): string {
  if (platform === 'macos') return hint
  return hint
    .replaceAll('⌃', 'ctrl+')
    .replaceAll('⇧', 'shift+')
    .replaceAll('⌥', 'alt+')
    .replaceAll('⌘', 'super+')
}

export const MAC_MODIFIER_GLYPHS = ['⌃', '⇧', '⌥', '⌘'] as const
