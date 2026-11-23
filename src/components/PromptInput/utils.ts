import { extendedKeysSupportedNow } from '../../ink/session/capabilities.js'
import { getGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'

export function isVimModeEnabled(): boolean {
  return getGlobalConfig().editorMode === 'vim'
}

export function getNewlineInstructions(): string {
  const config = getGlobalConfig()
  if (
    (env.terminal === 'Apple_Terminal' && env.platform === 'darwin') ||
    config.shiftEnterKeyBindingInstalled ||
    extendedKeysSupportedNow()
  ) {
    return 'shift + ↵ for a new line'
  }
  if (config.hasUsedBackslashReturn) {
    return '\\↵ for a new line'
  }
  return 'backslash (\\) + ↵ for a new line'
}
