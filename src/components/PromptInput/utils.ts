
import type { Key } from '../../ink/events/input-event.js'
import { extendedKeysSupportedNow } from '../../ink/session/capabilities.js'
import { getGlobalConfig } from '../../utils/config.js'
import { envDynamic } from '../../utils/envDynamic.js'

export function isVimModeEnabled(): boolean {
  return getGlobalConfig().editorMode === 'vim'
}

export function getNewlineInstructions(): string {
  const config = getGlobalConfig()
  const isMacSystemTerminal =
    process.platform === 'darwin' && envDynamic.terminal === 'Apple_Terminal'
  if (
    isMacSystemTerminal ||
    config.shiftEnterKeyBindingInstalled === true ||
    extendedKeysSupportedNow()
  ) {
    return 'shift + ↵ for a new line'
  }
  if (config.hasUsedBackslashReturn === true) {
    return '\\↵ for a new line'
  }
  return 'backslash (\\) + ↵ for a new line'
}

export function isNonSpacePrintable(chunk: string, key: Key): boolean {
  if (
    key.ctrl ||
    key.meta ||
    key.escape ||
    key.return ||
    key.tab ||
    key.backspace ||
    key.delete ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow ||
    key.pageUp ||
    key.pageDown ||
    key.home ||
    key.end
  ) {
    return false
  }
  if (chunk.length === 0) return false
  if (/^\s/.test(chunk)) return false
  if (chunk.startsWith('\u001b')) return false
  return true
}
