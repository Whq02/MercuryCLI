import { getSettings_DEPRECATED } from './settings/settings.js'
import { flagEnv } from '../substrate/flagRegistry.js'


export { modelSupportsAdaptiveThinking, modelSupportsThinking } from './model/capabilities.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

export function isDeepthinkEnabled(): boolean {
  return true
}

const DEEPTHINK_SOURCE = String.raw`\bdeepthink\b`
const DEEPTHINK_TEST = new RegExp(DEEPTHINK_SOURCE, 'i')

export function hasDeepthinkKeyword(text: string): boolean {
  return DEEPTHINK_TEST.test(text)
}

export function findThinkingTriggerPositions(
  text: string,
): Array<{ word: string; start: number; end: number }> {
  const pattern = new RegExp(DEEPTHINK_SOURCE, 'gi')
  const positions: Array<{ word: string; start: number; end: number }> = []
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    positions.push({ word: match[0], start: match.index, end: match.index + match[0].length })
  }
  return positions
}

export function shouldEnableThinkingByDefault(): boolean {
  const envValue = flagEnv('MERCURY_THINKING_BUDGET')
  if (envValue !== undefined && envValue !== '') {
    const parsed = parseInt(envValue, 10)
    return parsed > 0
  }
  if (getSettings_DEPRECATED().alwaysThinkingEnabled === false) {
    return false
  }
  return true
}

let sessionThinkingConfig: ThinkingConfig | undefined

export function noteSessionThinkingConfig(config: ThinkingConfig): void {
  sessionThinkingConfig = config
}

export function sessionThinkingEnabled(): boolean {
  const config =
    sessionThinkingConfig ?? (shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' })
  return config.type !== 'disabled'
}
