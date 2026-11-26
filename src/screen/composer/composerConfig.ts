import { extendedKeysSupportedNow } from '../renderer/terminal-session/capabilities.js'
import { getGlobalConfig } from '../../platform/settings/config.js'

export function isVimModeEnabled(): boolean {
  return getGlobalConfig().editorMode === 'vim'
}

function supportsShiftEnter(): boolean {
  return getGlobalConfig().shiftEnterKeyBindingInstalled || extendedKeysSupportedNow()
}

export function getNewlineInstructions(): string {
  if (supportsShiftEnter()) {
    return 'shift + ↵ for a new line'
  }
  if (getGlobalConfig().hasUsedBackslashReturn) {
    return '\\↵ for a new line'
  }
  return 'backslash (\\) + ↵ for a new line'
}

export function getShortNewlineInstructions(): string {
  return supportsShiftEnter() ? 'shift+↵ new line' : '\\ ↵ new line'
}
