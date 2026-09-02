// Composer utility predicates: the vim-mode probe, the newline
// instruction text, and the printable-keystroke predicate the raw handler
// and the cancel-request hook share.

import type { Key } from '../../ink/events/input-event.js'
import { extendedKeysSupportedNow } from '../../ink/session/capabilities.js'
import { getGlobalConfig } from '../../utils/config.js'
import { envDynamic } from '../../utils/envDynamic.js'

/** True when the persisted editor mode is the vim value. */
export function isVimModeEnabled(): boolean {
  return getGlobalConfig().editorMode === 'vim'
}

/** The instruction text appropriate to the terminal's newline capability:
 *  the modifier form on the macOS system terminal, wherever the shift+enter
 *  binding is installed, and on every terminal the extended-keys latch is
 *  up for (the raw-mode arm pushes the kitty protocol + modifyOtherKeys on
 *  exactly that read, and the composer decodes shift+↵ from both — a
 *  terminal that proved the protocol at boot gets the chord that works);
 *  otherwise the backslash fallback, shortened once the operator has used
 *  it. */
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

/** False for every modifier/navigation key and for empty input, input
 *  beginning with whitespace, or input beginning with an escape byte. */
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
