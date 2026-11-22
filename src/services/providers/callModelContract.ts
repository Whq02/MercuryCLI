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
import type { Unbuilt } from '../../pi/holes.js'

export type CallModelParams = Unbuilt

type CallModelYield = StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage

export type CallModelStream = AsyncGenerator<CallModelYield, void>

export type CallModel = (params: CallModelParams) => CallModelStream
