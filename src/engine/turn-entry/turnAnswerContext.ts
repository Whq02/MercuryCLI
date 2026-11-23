import type { QuerySource } from '../requests/querySource.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import type { Message } from '../message-shapes/message.js'
import type { SystemPrompt } from '../system-prompt/systemPromptType.js'

export type TurnAnswerContext = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}
