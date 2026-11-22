import type { ContentBlock, ToolUseBlock } from '../types/wire.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
} from '../types/message.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt } from '../pi/holes.js'

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
  return notBuilt('src/run-core/model-lane.ts:19')
}

export function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return notBuilt('src/run-core/model-lane.ts:55')
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
