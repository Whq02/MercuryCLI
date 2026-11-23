import type { Tools } from '../../tools/kit/tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../engine/message-shapes/message.js'
import type { SystemPrompt } from '../../engine/system-prompt/systemPromptType.js'
import type { ThinkingConfig } from '../effort/thinking.js'
import type { Options } from './anthropic/streamCore.js'
export type CallModelParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}

type CallModelYield = StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage

export type CallModelStream = AsyncGenerator<CallModelYield, void>

export type CallModel = (params: CallModelParams) => CallModelStream
