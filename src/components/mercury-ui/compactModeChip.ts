import {
  getModeColor,
  isDefaultMode,
  permissionModeSymbol,
  permissionModeTitle,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'

export type CompactModeChipTone = 'bypass' | 'unreported' | 'mode'

export type CompactModeChip = Readonly<{
  text: string
  tone: CompactModeChipTone
  modeColor: string
}>

export function compactModeChip(mode: PermissionMode | null): CompactModeChip | null {
  if (mode === null) return { text: 'permissions unreported', tone: 'unreported', modeColor: 'warning' }
  if (isDefaultMode(mode)) return null
  if (mode === 'sovereign') {
    return { text: `${permissionModeSymbol(mode)} sovereign · auto-approved`, tone: 'bypass', modeColor: getModeColor(mode) }
  }
  if (mode === 'autopilot') {
    return { text: `${permissionModeSymbol(mode)} autopilot · permissions bypassed`, tone: 'bypass', modeColor: getModeColor(mode) }
  }
  return { text: `${permissionModeSymbol(mode)} ${permissionModeTitle(mode).toLowerCase()}`, tone: 'mode', modeColor: getModeColor(mode) }
}

export function compactSummaryHint(facts: { focused: boolean; vimInsert: boolean; escHint: string; stripHint: string }): string {
  if (facts.focused) return '↵ details · esc back'
  return [facts.vimInsert ? 'INSERT' : '', facts.escHint, facts.stripHint].filter(part => part !== '').join(' · ')
}
