import type { ContentBlock, ToolUseBlock } from '../types/wire.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../types/message.js'
import { passedOver } from '../utils/passedOver.js'

type ToolLike = {
  backfillObservableInput?: (input: Record<string, unknown>) => void
}

type YieldInput = Message | StreamEvent

export function backfillCloneForYield<M extends YieldInput>(
  message: M,
  findTool: (name: string) => ToolLike | undefined,
): M
export function backfillCloneForYield(
  message: YieldInput,
  findTool: (name: string) => ToolLike | undefined,
): YieldInput {
  if (message.type !== 'assistant') return message
  let clonedContent: ContentBlock[] | undefined
  for (let i = 0; i < message.message.content.length; i++) {
    const block = message.message.content[i]!
    if (block.type === 'tool_use' && typeof block.input === 'object' && block.input !== null) {
      const tool = findTool(block.name)
      if (tool?.backfillObservableInput) {
        const originalInput = block.input as Record<string, unknown>
        const inputCopy = { ...originalInput }
        try {
          tool.backfillObservableInput(inputCopy)
        } catch (error) {
          passedOver(error)
          continue
        }
        const addedFields = Object.keys(inputCopy).some(k => !(k in originalInput))
        if (addedFields) {
          clonedContent ??= [...message.message.content]
          clonedContent[i] = { ...block, input: inputCopy }
        }
      }
    }
  }
  if (clonedContent) {
    return {
      ...message,
      message: { ...message.message, content: clonedContent },
    }
  }
  return message
}

export function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

type TurnBatch = {
  assistantMessages: unknown[]
  toolResults: unknown[]
  toolUseBlocks: ToolUseBlock[]
  early?: { resetForRetry(): void }
}

export function resetForRetry(batch: TurnBatch): { needsFollowUp: false } {
  batch.assistantMessages.length = 0
  batch.toolResults.length = 0
  batch.toolUseBlocks.length = 0
  batch.early?.resetForRetry()
  return { needsFollowUp: false }
}
