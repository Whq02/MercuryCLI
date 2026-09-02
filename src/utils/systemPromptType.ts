/**
 * The brand marking an assembled system-prompt string array.
 *
 * Zero imports here, on purpose: every module in the tree can take the
 * brand without any chance of a circular-initialization hazard.
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
