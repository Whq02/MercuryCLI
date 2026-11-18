import type { Message } from '../../types/message.js'
import {
  settleMemoryWriteRefusals,
  toolCallRefusalCorrection,
} from '../../services/providers/toolCallGate.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from '../../utils/messages.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { runTools } from '../../services/tools/toolOrchestration.js'
import { turnCutResultText, type TurnCut } from '../../utils/messages/rejectionText.js'
import type { Terminal } from '../../query/transitions.js'
import type { RunEvent } from '../events.js'
import type { EventMint, IterationState, RunCtx, TurnDecision } from './state.js'
import { emitSyntheticSettlements } from './streamModel.js'

const MAX_TURNS_CUT: TurnCut = { kind: 'cut', detail: 'the turn budget was spent' }

function toolUpdateEvent(message: Message, emit: EventMint): RunEvent {
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    const toolResult = message.message.content.find(
      c => c.type === 'tool_result',
    )
    if (toolResult) {
      return emit({
        kind: 'tool_settled',
        toolUseId: toolResult.tool_use_id,
        outcome: toolResult.is_error === true ? 'error' : 'ok',
        synthetic: false,
        message,
      })
    }
  }
  if (message.type === 'progress') {
    return emit({
      kind: 'tool_progress',
      toolUseId: message.toolUseID ?? '',
      message,
    })
  }
  if (message.type === 'attachment') {
    return emit({ kind: 'attachment', message })
  }
  return emit({ kind: 'notice', message })
}

export async function* runToolCalls(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, TurnDecision> {
  const { emit, pendingMemoryWrites, holdMemoryWriteRefusals, memoryWriteLostEvent } = run
  const { canUseTool, maxTurns } = run.params
  const { state, toolUseContext, closingTurn, callChain, assistantMessages, toolResults, toolUseBlocks, allRefusedToolCalls, refusedToolCalls, answeredRefusalIds } = iter
  const { turnCount } = state
  if (closingTurn && maxTurns !== undefined) {
    iter.early.reset()
    yield* emitSyntheticSettlements(assistantMessages, turnCutResultText(MAX_TURNS_CUT), 'aborted', emit)
    yield emit({
      kind: 'attachment',
      message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount }),
    })
    const lostAtCap = memoryWriteLostEvent()
    if (lostAtCap !== null) yield lostAtCap
    const terminal: Terminal = { reason: 'max_turns', turnCount }
    return { kind: 'end', terminal }
  }

  let shouldPreventContinuation = false
  let loopStoppedCycle: string[] | null = null
  let loopStoppedRecord: Message | null = null
  let updatedToolUseContext = toolUseContext


  for (const block of toolUseBlocks) {
    yield emit({
      kind: 'tool_started',
      toolUseId: block.id,
      toolName: block.name,
    })
  }

  const toolUpdates = runTools(
    toolUseBlocks,
    assistantMessages,
    canUseTool,
    toolUseContext,
    iter.early,
  )

  for await (const update of toolUpdates) {
    if (update.message) {
      if (
        update.message.type === 'attachment' &&
        update.message.attachment.type === 'loop_stopped'
      ) {
        loopStoppedCycle = update.message.attachment.cycle
        loopStoppedRecord = update.message
        continue
      }
      yield toolUpdateEvent(update.message, emit)

      if (
        update.message.type === 'attachment' &&
        update.message.attachment.type === 'hook' &&
        update.message.attachment.outcome === 'stop'
      ) {
        shouldPreventContinuation = true
      }

      if (update.message.type === 'attachment') {
        toolResults.push(update.message)
      } else {
        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
    }
    if (update.newContext) {
      updatedToolUseContext = {
        ...update.newContext,
        callChain,
      }
    }
  }

  settleMemoryWriteRefusals(pendingMemoryWrites, toolUseBlocks.filter(block => !answeredRefusalIds.has(block.id)))
  holdMemoryWriteRefusals(allRefusedToolCalls)
  if (refusedToolCalls.length > 0) {
    const correction = createUserMessage({
      content: toolCallRefusalCorrection(refusedToolCalls),
      isMeta: true,
    })
    yield emit({ kind: 'hook_message', message: correction })
    toolResults.push(correction)
  }

  iter.shouldPreventContinuation = shouldPreventContinuation
  iter.loopStoppedCycle = loopStoppedCycle
  iter.loopStoppedRecord = loopStoppedRecord
  iter.updatedToolUseContext = updatedToolUseContext
  return { kind: 'go_on' }
}
