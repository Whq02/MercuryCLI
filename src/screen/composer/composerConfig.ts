import { extendedKeysSupportedNow } from '../renderer/terminal-session/capabilities.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { envProbes } from '../../platform/environment/envProbes.js'

export function isVimModeEnabled(): boolean {
  return getGlobalConfig().editorMode === 'vim'
}

export function getNewlineInstructions(): string {
  const config = getGlobalConfig()
  if (
    (process.platform === 'darwin' && envProbes.terminal === 'Apple_Terminal') ||
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
