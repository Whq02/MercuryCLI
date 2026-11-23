import type { HistoryMode } from './useArrowKeyHistory.js'

export const BASH_MODE_CHARACTER = '!'

export function getModeFromInput(text: string): HistoryMode {
  return text.startsWith(BASH_MODE_CHARACTER) ? 'bash' : 'prompt'
}

export function getValueFromInput(text: string): string {
  return text.startsWith(BASH_MODE_CHARACTER) ? text.slice(1) : text
}

export function isInputModeCharacter(char: string): boolean {
  return char === BASH_MODE_CHARACTER
}
