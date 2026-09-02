import type { ToolUseBlock } from '../types/wire.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../types/message.js'

type ToolLike = {
  backfillObservableInput?: (input: Record<string, unknown>) => void
}

type AssistantLike = {
  type: string
  message: { content: Array<Record<string, unknown>> }
}

export function backfillCloneForYield<M>(
  message: M,
  findTool: (name: string) => ToolLike | undefined,
): M {
  const m = message as unknown as AssistantLike
  if (m.type !== 'assistant') return message
  let clonedContent: Array<Record<string, unknown>> | undefined
  for (let i = 0; i < m.message.content.length; i++) {
    const block = m.message.content[i]!
    if (block['type'] === 'tool_use' && typeof block['input'] === 'object' && block['input'] !== null) {
      const tool = findTool(block['name'] as string)
      if (tool?.backfillObservableInput) {
        const originalInput = block['input'] as Record<string, unknown>
        const inputCopy = { ...originalInput }
        tool.backfillObservableInput(inputCopy)
        const addedFields = Object.keys(inputCopy).some(k => !(k in originalInput))
        if (addedFields) {
          clonedContent ??= [...m.message.content]
          clonedContent[i] = { ...block, input: inputCopy }
        }
      }
    }
  }
  if (clonedContent) {
    return {
      ...m,
      message: { ...m.message, content: clonedContent },
    } as unknown as M
  }
  return message
}

export function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

export type TurnBatch = {
  assistantMessages: unknown[]
  toolResults: unknown[]
  toolUseBlocks: ToolUseBlock[]
}

export function resetForRetry(batch: TurnBatch): { needsFollowUp: false } {
  batch.assistantMessages.length = 0
  batch.toolResults.length = 0
  batch.toolUseBlocks.length = 0
  return { needsFollowUp: false }
}
