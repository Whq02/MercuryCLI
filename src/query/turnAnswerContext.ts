import type { QuerySource } from '../constants/querySource.js'
import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'

export type TurnAnswerContext = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}
