
import { getPlatform } from '../utils/platform.js'

export type ReservedShortcut = {
  key: string
  reason: string
  severity: 'error' | 'warning'
}

export const NON_REBINDABLE: ReservedShortcut[] = [
  { key: 'ctrl+c', reason: 'interrupt/exit is hardcoded', severity: 'error' },
  { key: 'ctrl+d', reason: 'exit is hardcoded', severity: 'error' },
  { key: 'ctrl+m', reason: 'identical to Enter in terminals (both send CR)', severity: 'error' },
]

export const TERMINAL_RESERVED: ReservedShortcut[] = [
  { key: 'ctrl+z', reason: 'Unix process suspend', severity: 'warning' },
  { key: 'ctrl+\\', reason: 'terminal quit signal', severity: 'error' },
]

export const WINDOWS_RESERVED: ReservedShortcut[] = [
  { key: 'ctrl+z', reason: 'Windows shells read ctrl+z as end-of-input; not a suspend', severity: 'warning' },
  { key: 'ctrl+v', reason: 'Windows console paste (the host delivers the clipboard, not the chord)', severity: 'warning' },
  { key: 'ctrl+shift+c', reason: 'Windows Terminal copy (arrives as plain ctrl+c)', severity: 'warning' },
  { key: 'ctrl+shift+v', reason: 'Windows Terminal paste', severity: 'warning' },
  { key: 'ctrl+shift+t', reason: 'Windows Terminal new tab', severity: 'warning' },
  { key: 'ctrl+shift+w', reason: 'Windows Terminal close pane/tab', severity: 'warning' },
  { key: 'ctrl+shift+n', reason: 'Windows Terminal new window', severity: 'warning' },
  { key: 'ctrl+shift+d', reason: 'Windows Terminal duplicate tab', severity: 'warning' },
  { key: 'ctrl+shift+f', reason: 'Windows Terminal find', severity: 'warning' },
  { key: 'ctrl+shift+p', reason: 'Windows Terminal command palette', severity: 'warning' },
  { key: 'ctrl+,', reason: 'Windows Terminal settings', severity: 'warning' },
  { key: 'ctrl+tab', reason: 'Windows Terminal next tab; conhost collapses it to a plain tab', severity: 'warning' },
  { key: 'ctrl+shift+tab', reason: 'Windows Terminal previous tab; conhost collapses it to a plain tab', severity: 'warning' },
  { key: 'alt+enter', reason: 'Windows Terminal fullscreen', severity: 'warning' },
  { key: 'alt+shift+d', reason: 'Windows Terminal split pane', severity: 'warning' },
]

export function reservedShortcutsFor(platform: ReturnType<typeof getPlatform>): ReservedShortcut[] {
  if (platform === 'windows') {
    const posixSignalRows = new Set(['ctrl+z', 'ctrl+\\'])
    return [...NON_REBINDABLE, ...TERMINAL_RESERVED.filter(s => !posixSignalRows.has(s.key)), ...WINDOWS_RESERVED]
  }
  const out = [...NON_REBINDABLE, ...TERMINAL_RESERVED]
  if (platform === 'macos') out.push(...MACOS_RESERVED)
  return out
}

export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: 'cmd+c', reason: 'system copy', severity: 'error' },
  { key: 'cmd+v', reason: 'system paste', severity: 'error' },
  { key: 'cmd+x', reason: 'system cut', severity: 'error' },
  { key: 'cmd+q', reason: 'quit application', severity: 'error' },
  { key: 'cmd+w', reason: 'close window/tab', severity: 'error' },
  { key: 'cmd+tab', reason: 'app switcher', severity: 'error' },
  { key: 'cmd+space', reason: 'Spotlight', severity: 'error' },
]

export function getReservedShortcuts(): ReservedShortcut[] {
  return reservedShortcutsFor(getPlatform())
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

function normalizeStep(step: string): string {
  const modifiers: string[] = []
  let key = ''
  for (const rawToken of step.split('+')) {
    const token = rawToken.trim().toLowerCase()
    const canon = MODIFIER_CANON[token]
    if (canon) modifiers.push(canon)
    else key = token
  }
  modifiers.sort()
  return [...modifiers, key].join('+')
}

export function normalizeKeyForComparison(key: string): string {
  return key
    .trim()
    .split(/\s+/)
    .filter(step => step !== '')
    .map(normalizeStep)
    .join(' ')
}
