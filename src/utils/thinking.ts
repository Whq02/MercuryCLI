import type { Theme } from './theme.js'
import { getSettings_DEPRECATED } from './settings/settings.js'


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

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]
const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(charIndex: number, shimmer: boolean = false): keyof Theme {
  const palette = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return palette[charIndex % palette.length] as keyof Theme
}

export function shouldEnableThinkingByDefault(): boolean {
  const envValue = process.env.MAX_THINKING_TOKENS
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
