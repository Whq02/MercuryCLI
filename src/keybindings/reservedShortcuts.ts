import { getPlatform } from '../utils/platform.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export type ReservedShortcut = Unbuilt

export const NON_REBINDABLE: ReservedShortcut[] = unbuilt('src/keybindings/reservedShortcuts.ts:10')

export const TERMINAL_RESERVED: ReservedShortcut[] = unbuilt('src/keybindings/reservedShortcuts.ts:16')

export const WINDOWS_RESERVED: ReservedShortcut[] = unbuilt('src/keybindings/reservedShortcuts.ts:21')

export function reservedShortcutsFor(platform: ReturnType<typeof getPlatform>): ReservedShortcut[] {
  if (platform === 'windows') {
    const posixSignalRows = new Set(['ctrl+z', 'ctrl+\\'])
    return [...NON_REBINDABLE, ...TERMINAL_RESERVED.filter(s => !posixSignalRows.has(s.key)), ...WINDOWS_RESERVED]
  }
  const out = [...NON_REBINDABLE, ...TERMINAL_RESERVED]
  if (platform === 'macos') out.push(...MACOS_RESERVED)
  return out
}

export const MACOS_RESERVED: ReservedShortcut[] = unbuilt('src/keybindings/reservedShortcuts.ts:49')

export function getReservedShortcuts(): ReservedShortcut[] {
  return notBuilt('src/keybindings/reservedShortcuts.ts:59')
}

const MODIFIER_CANON: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  opt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'cmd',
  command: 'cmd',
  shift: 'shift',
}

export function normalizeKeyForComparison(key: string): string {
  return notBuilt('src/keybindings/reservedShortcuts.ts:88')
}
