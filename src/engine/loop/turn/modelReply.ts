import type { AssistantMessage, RefusedToolCall } from '../../message-shapes/message.js'
import { getModelMaxOutputTokens } from '../../../models/facts/capabilities.js'
import { outputRoomOf } from '../../requests/outputFit.js'
import { declaredRouteOf } from '../../../models/roads/callModelRouter.js'
import { collectRefusedToolCalls, unansweredRefusals } from '../../../models/roads/toolCallGate.js'
import { createSystemMessage, createUserInterruptionMessage } from '../../messages/messages.js'
import { turnCutOf, turnCutResultText } from '../../message-shapes/rejectionText.js'
import { isWithheldMaxOutputTokens } from '../model-lane.js'
import type { RunEvent } from '../events.js'
import { CUT_TOOL_CALL_RECOVERY_LIMIT, decideCutToolCallRecovery } from './judgements.js'
import { trimChantedIteration, type IterationState, type NextTurn, type RunCtx, type TurnDecision } from './turnState.js'
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
  const { toolUseContext } = iter
  const { signal } = toolUseContext.abortController

  const outcome = yield* streamModel(run, iter, emit)
  if (outcome.kind === 'terminal') return { kind: 'end', terminal: outcome.terminal }
  if (iter.thinkingRecords.length > 0) iter.messagesForQuery = [...iter.messagesForQuery, ...iter.thinkingRecords]
  if (iter.streamChant !== undefined && !signal.aborted) yield* trimChantedIteration(iter, iter.streamChant, emit)

  if (signal.aborted) {
    iter.early.reset()
    yield* emitSyntheticSettlements(iter.assistantMessages, turnCutResultText(turnCutOf(signal.reason)), 'aborted', emit)
    const steer = signal.reason === 'interrupt'
    yield emit({
      kind: 'interruption',
      phase: 'stream',
      steer,
      message: steer ? null : createUserInterruptionMessage({ toolUse: false, reason: signal.reason }),
    })
    return { kind: 'end', terminal: { reason: 'aborted_streaming' } }
  }

  const refused = collectRefusedToolCalls(iter.assistantMessages)
  const unanswered = unansweredRefusals(iter.assistantMessages)
  const cut = cutToolCallOf(iter.assistantMessages, unanswered)
  if (cut !== null) {
    const route = declaredRouteOf(iter.currentModel)
    const limits = getModelMaxOutputTokens(iter.currentModel)
    const decision = decideCutToolCallRecovery({
      recoveryCount: iter.state.cutToolCallRecoveryCount ?? 0,
      sentCap: iter.state.maxOutputTokensOverride ?? (route === 'anthropic' ? limits.default : undefined),
      cutAt: cut.cutAt,
      upperLimit: limits.upperLimit,
      room: outputRoomOf(iter.messagesForQuery, iter.currentModel, [iter.fullSystemPrompt, toolUseContext.options.tools]),
      routeTakesCap: route !== 'openai',
    })
    if (decision.kind === 'retry') {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          `the reply was cut at ${cut.cutAt.toLocaleString('en-US')} output tokens inside a tool call (${cut.name}) — re-asking with room for ${decision.outputTokens.toLocaleString('en-US')} (${decision.attempt} of ${CUT_TOOL_CALL_RECOVERY_LIMIT}); nothing ran`,
          'warning',
        ),
      })
      for (const message of iter.assistantMessages) {
        if (message.inReplyTo !== undefined && message.inReplyTo.length > 0) iter.replyTo.unshift(...message.inReplyTo)
        yield emit({ kind: 'assistant_retracted', message })
      }
      const next: NextTurn = {
        ...iter.state,
        messages: iter.messagesForQuery,
        autoCompactTracking: iter.tracking,
        maxOutputTokensOverride: decision.outputTokens,
        cutToolCallRecoveryCount: decision.attempt,
        stopHookActive: undefined,
        pendingOverflow: undefined,
        transition: { reason: 'cut_tool_call_recovery', attempt: decision.attempt, outputTokens: decision.outputTokens },
      }
      return { kind: 'hand_over', next }
    }
  }

  iter.allRefusedToolCalls = refused
  iter.refusedToolCalls = unanswered
  iter.answeredRefusalIds = new Set(refused.filter(refusal => !unanswered.includes(refusal)).map(refusal => refusal.id))
  return { kind: 'go_on' }
}
