import type { Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../types/message.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import type { Options } from './anthropic/streamCore.js'

export type CallModelParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}

export type CallModelYield = StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage

export type CallModelStream = AsyncGenerator<CallModelYield, void>

export type CallModel = (params: CallModelParams) => CallModelStream
