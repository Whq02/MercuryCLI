import type { Theme } from './theme.js'
import { getSettings_DEPRECATED } from './settings/settings.js'

/**
 * Extended-thinking policy: the keyword trigger, the default-on rule, and
 * the rainbow trigger palette. The capability predicates are owned at the
 * provider-capability edge and re-exported here so the older import path
 * keeps working; this module owns policy.
 */

export { modelSupportsAdaptiveThinking, modelSupportsThinking } from './model/capabilities.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/** The deepthink gate is unconditionally on in this build. */
export function isDeepthinkEnabled(): boolean {
  return true
}

// The operator types this; matched case-insensitively on word boundaries.
const DEEPTHINK_SOURCE = String.raw`\bdeepthink\b`
const DEEPTHINK_TEST = new RegExp(DEEPTHINK_SOURCE, 'i')

export function hasDeepthinkKeyword(text: string): boolean {
  return DEEPTHINK_TEST.test(text)
}

/**
 * Every occurrence with offsets, for highlighting and notification. A
 * FRESH global pattern per call: the match-all API seeds itself from the
 * pattern's stored last-index, so sharing one instance with the boolean
 * test would let one call displace the next call's reported positions.
 */
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

// Theme token names — contract data.
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

/**
 * The default-on rule. `MAX_THINKING_TOKENS`, when set to a non-empty
 * value, decides alone: on exactly when its base-ten integer parse is
 * greater than zero (an unparseable value reads as off). Otherwise an
 * explicit `false` always-thinking setting turns it off. Otherwise ON.
 *
 * WARNING: this default materially affects model quality. Do not change it
 * casually.
 */
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

// The session's thinking config, noted once at boot by the one builder
// (main.tsx resolves the flag, the token budget and the default-on rule
// into it and hands the same value to every request through the options).
// Display surfaces read it here so they answer the question the request
// builders answer from their options: on a lane whose effort dial is its
// reasoning dial, thinking off means no dial is sent. Unset (a prover, a
// child before its boot) ⇒ the default-on rule.
let sessionThinkingConfig: ThinkingConfig | undefined

export function noteSessionThinkingConfig(config: ThinkingConfig): void {
  sessionThinkingConfig = config
}

export function sessionThinkingEnabled(): boolean {
  const config =
    sessionThinkingConfig ?? (shouldEnableThinkingByDefault() ? { type: 'adaptive' } : { type: 'disabled' })
  return config.type !== 'disabled'
}
