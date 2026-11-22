import type { HistoryMode } from '../../hooks/useArrowKeyHistory.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export const BASH_MODE_CHARACTER: Unbuilt = unbuilt('src/components/PromptInput/inputModes.ts:4')

export function getModeFromInput(text: string): HistoryMode {
  return notBuilt('src/components/PromptInput/inputModes.ts:6')
}

export function getValueFromInput(text: string): string {
  return notBuilt('src/components/PromptInput/inputModes.ts:11')
}

export function isInputModeCharacter(char: string): boolean {
  return notBuilt('src/components/PromptInput/inputModes.ts:16')
}
