import type { Message } from '../../message-shapes/message.js'
import {
  settleMemoryWriteRefusals,
  toolCallRefusalCorrection,
} from '../../../models/roads/toolCallGate.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from '../../messages/messages.js'
import { createAttachmentMessage } from '../../attachments/attachments.js'
import { runTools } from '../../tool-dispatch/toolOrchestration.js'
import { turnCutResultText, type TurnCut } from '../../message-shapes/rejectionText.js'
import type { Terminal } from '../../turn-entry/transitions.js'
import type { RunEvent } from '../events.js'
import type { EventMint, IterationState, RunCtx, TurnDecision } from './turnState.js'
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
  const { emit } = run
  const { maxTurns } = run.params
  if (iter.closingTurn && maxTurns !== undefined) {
    iter.early.reset()
    yield* emitSyntheticSettlements(iter.assistantMessages, turnCutResultText(MAX_TURNS_CUT), 'aborted', emit)
    yield emit({
      kind: 'attachment',
      message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: iter.state.turnCount }),
    })
    const lost = run.memoryWriteLostEvent()
    if (lost !== null) yield lost
    const terminal: Terminal = { reason: 'max_turns', turnCount: iter.state.turnCount }
    return { kind: 'end', terminal }
  }

  for (const block of iter.toolUseBlocks) {
    yield emit({ kind: 'tool_started', toolUseId: block.id, toolName: block.name })
  }

  let updatedToolUseContext = iter.toolUseContext
  let shouldPreventContinuation = false
  let loopStoppedCycle: string[] | null = null
  let loopStoppedRecord: Message | null = null
  const { tools } = iter.toolUseContext.options
  for await (const update of runTools(iter.toolUseBlocks, iter.assistantMessages, run.params.canUseTool, iter.toolUseContext, iter.early)) {
    const { message } = update
    if (message !== undefined && message.type === 'attachment' && message.attachment.type === 'loop_stopped') {
      loopStoppedCycle = message.attachment.cycle
      loopStoppedRecord = message
      continue
    }
    updatedToolUseContext = { ...update.newContext, callChain: iter.callChain }
    if (message === undefined) continue
    yield toolUpdateEvent(message, emit)
    if (message.type === 'attachment') {
      if (message.attachment.type === 'hook' && message.attachment.outcome === 'stop') shouldPreventContinuation = true
      iter.toolResults.push(message)
      continue
    }
    for (const row of normalizeMessagesForAPI([message], tools)) {
      if (row.type === 'user') iter.toolResults.push(row)
    }
  }

  settleMemoryWriteRefusals(run.pendingMemoryWrites, iter.toolUseBlocks.filter(block => !iter.answeredRefusalIds.has(block.id)))
  run.holdMemoryWriteRefusals(iter.allRefusedToolCalls)
  if (iter.refusedToolCalls.length > 0) {
    const correction = createUserMessage({ content: toolCallRefusalCorrection(iter.refusedToolCalls), isMeta: true })
    yield emit({ kind: 'hook_message', message: correction })
    iter.toolResults.push(correction)
  }

  iter.shouldPreventContinuation = shouldPreventContinuation
  iter.loopStoppedCycle = loopStoppedCycle
  iter.loopStoppedRecord = loopStoppedRecord
  iter.updatedToolUseContext = updatedToolUseContext
  return { kind: 'go_on' }
}
