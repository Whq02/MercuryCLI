import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import type { SystemPrompt } from '../systemPromptType.js'
import type { QuerySource } from '../../constants/querySource.js'
import { logError } from '../log.js'


export type ChatHookContext = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}

type PostSamplingHook = (context: ChatHookContext) => Promise<void> | void

const hooks: PostSamplingHook[] = []

export function registerPostSamplingHook(hook: PostSamplingHook): void {
  hooks.push(hook)
}


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
