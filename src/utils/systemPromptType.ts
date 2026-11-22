import { notBuilt, type Unbuilt } from '../pi/holes.js'

export type SystemPrompt = Unbuilt

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return notBuilt('src/utils/systemPromptType.ts:6')
}
