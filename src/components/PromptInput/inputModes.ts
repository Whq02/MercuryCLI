
import type { HistoryMode } from '../../hooks/useArrowKeyHistory.js'

export const BASH_MODE_CHARACTER = '!'

export function getModeFromInput(text: string): HistoryMode {
  if (text.startsWith(BASH_MODE_CHARACTER)) return 'bash'
  return 'prompt'
}

export function getValueFromInput(text: string): string {
  if (text.startsWith(BASH_MODE_CHARACTER)) return text.slice(1)
  return text
}

export function isInputModeCharacter(char: string): boolean {
  return char === BASH_MODE_CHARACTER
}
