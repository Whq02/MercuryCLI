import type {
  AssistantMessage,
  RefusedToolCall,
} from '../../types/message.js'
import {
  collectRefusedToolCalls,
  unansweredRefusals,
} from '../../services/providers/toolCallGate.js'
import {
  createUserInterruptionMessage,
  createSystemMessage,
} from '../../utils/messages.js'
import { getModelMaxOutputTokens } from '../../utils/model/capabilities.js'
import { outputRoomOf } from '../../services/api/outputFit.js'
import { declaredRouteOf } from '../../services/providers/callModelRouter.js'
import { turnCutOf, turnCutResultText } from '../../utils/messages/rejectionText.js'
import type { Terminal } from '../../query/transitions.js'
import { isWithheldMaxOutputTokens } from '../model-lane.js'
import type { RunEvent } from '../events.js'
import { CUT_TOOL_CALL_RECOVERY_LIMIT, decideCutToolCallRecovery } from './judgements.js'
import { trimChantedIteration, type IterationState, type NextTurn, type RunCtx, type TurnDecision } from './state.js'
import { emitSyntheticSettlements, streamModel } from './streamModel.js'

function cutToolCallOf(assistantMessages: readonly AssistantMessage[], refused: readonly RefusedToolCall[]): { name: string; cutAt: number } | null {
  const cut = refused.find(r => r.code === 'invalid-json')
  if (cut === undefined) return null
  const replies = assistantMessages.filter(m => m.isApiErrorMessage !== true)
  const stopped = assistantMessages.some(isWithheldMaxOutputTokens) || replies.some(m => m.message.stop_reason === 'max_tokens')
  if (!stopped) return null
  const cutAt = Math.max(0, ...replies.map(m => m.message.usage?.output_tokens ?? 0))
  return { name: cut.name || 'unnamed', cutAt }
}

export async function* modelReply(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, TurnDecision> {
  const { emit } = run
  const { state, toolUseContext, thinkingRecords, tracking } = iter
  const { maxOutputTokensOverride, turnCount } = state
  let { messagesForQuery } = iter
  const streamOutcome = yield* streamModel(run, iter, emit)
  if (streamOutcome.kind === 'terminal') {
    return { kind: 'end', terminal: streamOutcome.terminal }
  }
  if (thinkingRecords.length > 0) messagesForQuery = [...messagesForQuery, ...thinkingRecords]
  iter.messagesForQuery = messagesForQuery
  if (iter.streamChant !== undefined && !toolUseContext.abortController.signal.aborted) yield* trimChantedIteration(iter, iter.streamChant, emit)
  const { assistantMessages } = iter
  const allRefusedToolCalls = collectRefusedToolCalls(assistantMessages)
  const refusedToolCalls = unansweredRefusals(assistantMessages)
  const answeredRefusalIds = new Set(allRefusedToolCalls.filter(refusal => !refusedToolCalls.includes(refusal)).map(refusal => refusal.id))


  if (toolUseContext.abortController.signal.aborted) {
    iter.early.reset()
    const cutReason = toolUseContext.abortController.signal.reason
    yield* emitSyntheticSettlements(
      assistantMessages,
      turnCutResultText(turnCutOf(cutReason)),
      'aborted',
      emit,
    )
    const steer = cutReason === 'interrupt'
    yield emit({
      kind: 'interruption',
      phase: 'stream',
      steer,
      message: steer ? null : createUserInterruptionMessage({ toolUse: false, reason: cutReason }),
    })
    const terminal: Terminal = { reason: 'aborted_streaming' }
    return { kind: 'end', terminal }
  }

  const cutCall = cutToolCallOf(assistantMessages, refusedToolCalls)
  if (cutCall !== null) {
    const cutToolCallRecoveryCount = state.cutToolCallRecoveryCount ?? 0
    const route = declaredRouteOf(iter.currentModel)
    const decision = decideCutToolCallRecovery({
      recoveryCount: cutToolCallRecoveryCount,
      sentCap: maxOutputTokensOverride ?? (route === 'anthropic' ? getModelMaxOutputTokens(iter.currentModel).default : undefined),
      cutAt: cutCall.cutAt,
      upperLimit: getModelMaxOutputTokens(iter.currentModel).upperLimit,
      room: outputRoomOf(messagesForQuery, iter.currentModel, [iter.fullSystemPrompt, toolUseContext.options.tools]),
      routeTakesCap: route !== 'openai',
    })
    if (decision.kind === 'retry') {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          `the reply was cut at ${cutCall.cutAt.toLocaleString('en-US')} output tokens inside a tool call (${cutCall.name}) — re-asking with room for ${decision.outputTokens.toLocaleString('en-US')} (${decision.attempt} of ${CUT_TOOL_CALL_RECOVERY_LIMIT}); nothing ran`,
          'warning',
        ),
      })
      for (const msg of assistantMessages) {
        if (msg.inReplyTo !== undefined) iter.replyTo.unshift(...msg.inReplyTo)
        yield emit({ kind: 'assistant_retracted', message: msg })
      }
      const next: NextTurn = {
        ...state,
        messages: messagesForQuery,
        autoCompactTracking: tracking,
        maxOutputTokensOverride: decision.outputTokens,
        cutToolCallRecoveryCount: cutToolCallRecoveryCount + 1,
        stopHookActive: undefined,
        turnCount,
        pendingOverflow: undefined,
        transition: { reason: 'cut_tool_call_recovery', attempt: decision.attempt, outputTokens: decision.outputTokens },
      }
      return { kind: 'hand_over', next }
    }
  }

  iter.allRefusedToolCalls = allRefusedToolCalls
  iter.refusedToolCalls = refusedToolCalls
  iter.answeredRefusalIds = answeredRefusalIds
  return { kind: 'go_on' }
}
