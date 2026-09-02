// ============================================================================
//  run-core/model-lane.ts — T8: the model-call lane's
//  pure decisions.
//
//  The stream-consumption loop's three load-bearing rules, each stated
//  once (prove-runloop-contract pins all three end-to-end):
//
//  • BACKFILL CLONE-ON-YIELD — tool_use inputs are backfilled with
//    legacy/derived fields for the SDK stream + transcript, but the
//    ORIGINAL message object flows back to the API: mutating it breaks
//    prompt caching (byte mismatch), and cloning what goes to the API
//    breaks it the same way. A clone is minted ONLY when backfill ADDED
//    fields — overwrites (file tools expanding file_path) change the
//    serialized transcript and break VCR fixture hashes on resume while
//    adding nothing the SDK stream needs (hooks get expanded paths via
//    toolExecution separately).
//
//  • WITHHOLDING — a recovery-managed error is pushed to the batch so the
//    recovery ladder can find it, but NOT surfaced: leaking an
//    intermediate max_output_tokens error terminates SDK/desktop
//    consumers mid-recovery. max_output_tokens is the ONE live withheld
//    class in this build — the prompt-too-long/media lanes rode the
//    folded-out reactiveCompact module (a real 413 streams through
//    un-withheld and lands on the API-error return; L16 pins it).
//
//  • RETRY RESET — the streaming-fallback mid-stream reset and the
//    FallbackTriggeredError reset are the SAME recipe (the old body wrote
//    it twice): drop the batch arrays so no orphan of the abandoned
//    attempt (assistants, tool_use blocks, stale tool_results) leaks into
//    the retry, and reset the follow-up latch.
// ============================================================================
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

/** The clone-on-yield decision. Returns the message to YIELD — either the
 *  original (no additive backfill) or a clone carrying the added fields;
 *  the ORIGINAL is what the caller pushes to the API batch either way. */
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

/**
 * Is this a max_output_tokens error message? If so, the stream settlement
 * withholds it from consumers until we know whether the recovery ladder can
 * continue. Surfacing early leaks an intermediate error to SDK callers
 * (e.g. cowork/desktop) that terminate the session on any `error` field —
 * the recovery loop keeps running but nobody is listening.
 */
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

/** The shared retry-reset recipe: empty the batch in place (the arrays are
 *  closure-shared) and reset the follow-up latch so the retry starts from
 *  a clean turn. */
export function resetForRetry(batch: TurnBatch): { needsFollowUp: false } {
  batch.assistantMessages.length = 0
  batch.toolResults.length = 0
  batch.toolUseBlocks.length = 0
  return { needsFollowUp: false }
}
