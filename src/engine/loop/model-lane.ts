import type { ContentBlock, ToolUseBlock } from '../message-shapes/wire.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../message-shapes/message.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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
  let replaced = false
  const content = message.message.content.map((block): ContentBlock => {
    if (block.type !== 'tool_use' || typeof block.input !== 'object' || block.input === null) return block
    const tool = findTool(block.name)
    if (tool?.backfillObservableInput === undefined) return block
    const original = block.input as Record<string, unknown>
    const filled = { ...original }
    try {
      tool.backfillObservableInput(filled)
    } catch (error) {
      passedOver(error)
      return block
    }
    if (!Object.keys(filled).some(key => !(key in original))) return block
    replaced = true
    return { ...block, input: filled }
  })
  return replaced ? { ...message, message: { ...message.message, content } } : message
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
