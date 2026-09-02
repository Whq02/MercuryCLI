import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { SystemPrompt } from '../systemPromptType.js'
import type { QuerySource } from '../../constants/querySource.js'
import { logError } from '../log.js'

/**
 * Internal registry of after-sampling callbacks — programmatic only,
 * deliberately not exposed through settings.
 */

export type REPLHookContext = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}

export type PostSamplingHook = (context: REPLHookContext) => Promise<void> | void

const hooks: PostSamplingHook[] = []

export function registerPostSamplingHook(hook: PostSamplingHook): void {
  hooks.push(hook)
}

export function clearPostSamplingHooks(): void {
  hooks.length = 0
}

/**
 * Sequential on purpose, and one failing hook never fails the turn.
 */
export async function executePostSamplingHooks(
  messages: Message[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook({ messages, systemPrompt, userContext, systemContext, toolUseContext, querySource })
    } catch (error) {
      logError(error)
    }
  }
}
