// Pure mode encoding/decoding for the composer's bash-prefix mode.
// The mode character is contract data: `!`.

import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { HistoryMode } from '../../hooks/useArrowKeyHistory.js'

export const BASH_MODE_CHARACTER = '!'

/** Re-encode a mode into the text; identity for the prompt mode. */
export function prependModeCharacterToInput(
  text: string,
  mode: PromptInputMode,
): string {
  if (mode === 'bash') return `${BASH_MODE_CHARACTER}${text}`
  return text
}

/** Decode the leading mode character. */
export function getModeFromInput(text: string): HistoryMode {
  if (text.startsWith(BASH_MODE_CHARACTER)) return 'bash'
  return 'prompt'
}

/** Strip the mode character when present. */
export function getValueFromInput(text: string): string {
  if (text.startsWith(BASH_MODE_CHARACTER)) return text.slice(1)
  return text
}

/** True only for the single bash mode character — an exact one-character
 *  comparison, not a prefix test. */
export function isInputModeCharacter(char: string): boolean {
  return char === BASH_MODE_CHARACTER
}
