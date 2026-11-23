import { basename } from 'node:path'
import wrapText from '../../renderer/wrap-text.js'
import { getFocusedWorkspaceCwd } from '../../focused-session/useFocusedWorkspaceCwd.js'
import { GLYPH } from '../../theme/glyphs.js'

export const CONFIG_POPUP_WIDTH = 110
export const CONFIG_POPUP_ROWS = 44
export const CONFIG_POPUP_HINT = '↑↓ select · pgup/pgdn page · ←/→ change · ↵ save · / search · esc or click outside closes'
export const CONFIG_SEARCH_PLACEHOLDER = 'Search settings…'
export const CONFIG_LIST_CHROME_ROWS = 3
export const CONFIG_ROW_MARK = GLYPH.chevronRight

export function configPopupLine(folder: string, settings: number, setByYou: number): string {
  return `${folder} · ${settings} setting${settings === 1 ? '' : 's'} · ${setByYou} set by you`
}

export function configPopupFolder(cwd: string = getFocusedWorkspaceCwd()): string {
  const name = basename(cwd)
  return name === '' ? cwd : name
}

export function configMoreRow(hiddenBelow: number): string {
  return hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : ''
}

export function configWarningRows(warning: string, width: number): number {
  return wrapText(`  ${warning}`, Math.max(1, width), 'wrap').split('\n').length
}

export type ConfigListWindow = { sel: number; off: number; hiddenBelow: number; overflows: boolean }

export function configListWindow(selected: number, offset: number, total: number, windowSize: number): ConfigListWindow {
  const size = Math.max(1, windowSize)
  const sel = Math.max(0, Math.min(selected, total - 1))
  let off = offset
  if (sel < off) off = sel
  if (sel >= off + size) off = sel - size + 1
  off = Math.max(0, Math.min(off, Math.max(0, total - size)))
  return { sel, off, hiddenBelow: Math.max(0, total - off - size), overflows: total > size }
}
