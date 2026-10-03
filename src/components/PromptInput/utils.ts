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
