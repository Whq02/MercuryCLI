import { projectTimeBasedMicrocompact } from '../../services/compact/microCompact.js'
import { getIsNonInteractiveSession, getSessionKind } from '../../bootstrap/state.js'
import {
  FRESH_OVERFLOW_EPISODE,
  decideOverflowRecovery,
  measureOverflow,
  foldAvailability,
  overflowGapFor,
  overflowLadderArmed,
  overflowRecoveryNotice,
  overflowRefusalText,
  requestSizeWarning,
  requestSizeWarningApplies,
  foldRemedyIsHeadless,
  splitCarriedOperatorTail,
} from '../../services/compact/overflowRecovery.js'
import { overflowSignalOf } from '../../services/api/overflowSignal.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
} from '../../types/message.js'
import {
  EMPTY_REPLY_RECOVERY_NUDGE,
  continuableStreamFaultTextOf,
  endsWithEmptyReplyRecoveryNudge,
  isContinuableStreamFaultMessage,
  REASONING_CUT_MARKER,
  reasoningOnlyNoticeLine,
  reasoningOnlyRecoveryNudge,
  streamFaultFactsOf,
  streamFaultNoticeLine,
  streamFaultRecoveryContent,
} from '../../services/api/errors.js'
import { toolCallRefusalCorrection } from '../../services/providers/toolCallGate.js'
import {
  createUserMessage,
  createSystemMessage,
  createCloseUsageMessage,
  createStreamCutMessage,
  createAssistantAPIErrorMessage,
} from '../../utils/messages.js'
import {
  CHANT_RECOVERY_LIMIT,
  chantNoticeLine,
  chantNudgeText,
  chantStopText,
  decideChantRecovery,
  detectChant,
} from '../../services/tools/chantGuard.js'
import { isLoopGuardStopEnabled, LOOP_GUARD_STOP_SETTING } from '../../services/tools/loopGuard.js'
import {
  createSettleGuardWarning,
  findActiveCheckpoint,
} from '../../services/compact/checkpointRewind.js'
import {
  createAttachmentMessage,
  getAgentPendingMessageAttachments,
} from '../../utils/attachments.js'
import { getModelMaxOutputTokens } from '../../utils/model/capabilities.js'
import { getTotalCostUSD, ledgerMark, ledgerSpentSince } from '../../bootstrap/state.js'
import { handleStopHooks } from '../../query/stopHooks.js'
import { announcesNextStep } from '../../services/run/completionEvaluator.js'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import { requestWaitLine } from '../../services/providers/streamIdleBudget.js'
import { createCacheSafeParams } from '../../utils/forkedAgent.js'
import { askForHandoff, assistantText, handoffAskDue, handoffNotice } from '../../mneme/handoffAsk.js'
import { finishMemorySignal } from '../../mneme/mnemeSignal.js'
import { emptyReplyEndedLine, emptyReplyKindOf, emptyReplyNoteOf, emptyReplyNoticeLine } from '../../services/providers/emptyReply.js'
import type { Terminal } from '../../query/transitions.js'
import { isWithheldMaxOutputTokens } from '../model-lane.js'
import type { RunEvent } from '../events.js'
import {
  EMPTY_REPLY_RECOVERY_LIMIT,
  PAUSE_TURN_CONTINUATION_LIMIT,
  REASONING_CUT_RECOVERY_LIMIT,
  STREAM_FAULT_RECOVERY_LIMIT,
  TOOL_CALL_REFUSAL_RECOVERY_LIMIT,
  decideEmptyReplyRecovery,
  decidePauseTurnContinuation,
  decideReasoningOnlyRecovery,
  decideStreamFaultRecovery,
  decideToolCallRefusalRecovery,
} from './judgements.js'
import { trimChantedIteration, type EventMint, type IterationState, type NextTurn, type RunCtx, type SettledDecision, type TurnDecision } from './state.js'

const OUTPUT_LIMIT_RECOVERY_TEXT =
  'The reply hit the output ceiling. Carry on from exactly where it stopped — no recap, no apology — in smaller pieces.'

const OUTPUT_LIMIT_STOP_WORDS = {
  repeat: 'the reply hit the output ceiling and the continuation repeated what already stood; the turn ends here',
  budget: "the reply hit the output ceiling and the run's budget is spent; the turn ends here",
} as const

const ANNOUNCED_STEP_NUDGE_LIMIT = 1

const ANNOUNCED_STEP_NUDGE =
  'You ended your turn right after announcing a next step, with no tool call: if the task still needs that step, do it now; if the task is already done, give your final answer.'

const ANNOUNCED_STEP_NOTICE =
  'The reply announced a next step and ended the turn with no tool call — asked the model once to take it or to give its final answer'

const ANNOUNCED_STEP_AGAIN_NOTICE =
  'The reply announced a next step again and ended the turn with no tool call — the model was already asked once; the turn ends here'

function runLeftAlone(toolUseContext: ToolUseContext): boolean {
  return toolUseContext.agentId !== undefined || (getIsNonInteractiveSession() && getSessionKind() !== 'oculus')
}

function endedWithoutWords(assistantMessages: readonly AssistantMessage[]): boolean {
  const last = assistantMessages.at(-1)
  if (last !== undefined && last.message.stop_reason !== 'end_turn') return false
  return assistantMessages.every(
    message =>
      message.isApiErrorMessage !== true &&
      Array.isArray(message.message.content) &&
      message.message.content.every(block => block.type === 'text' && (block.text.trim() === '' || block.text === NO_CONTENT_MESSAGE)),
  )
}

function continuationAdded(previous: string | undefined, next: string): boolean {
  if (previous === undefined) return true
  const added = next.trim()
  if (added === '') return false
  const stood = previous.trim()
  if (added === stood) return false
  return stood.length < 80 || !added.includes(stood.slice(-80))
}

type StopHookGateResult = {
  preventContinuation: boolean
  blockingErrors: Message[]
}

async function* runStopHookGate(
  gen: ReturnType<typeof handleStopHooks>,
  emit: EventMint,
): AsyncGenerator<RunEvent, StopHookGateResult> {
  let result: StopHookGateResult
  try {
    while (true) {
      const r = await gen.next()
      if (r.done) {
        result = r.value
        break
      }
      yield emit({ kind: 'hook_message', message: r.value })
    }
  } finally {
    await gen.return(undefined as never)
  }
  yield emit({
    kind: 'hook_gate',
    gate: 'stop',
    outcome: result.preventContinuation
      ? 'prevented'
      : result.blockingErrors.length > 0
        ? 'blocking'
        : 'passed',
    messages: result.blockingErrors,
  })
  return result
}

type MaxOutputTokensDecision =
  | { kind: 'nudge'; attempt: number }
  | { kind: 'surface'; why: keyof typeof OUTPUT_LIMIT_STOP_WORDS }

function pausedReplyOf(assistantMessages: readonly AssistantMessage[]): AssistantMessage | null {
  const reply = assistantMessages.filter(m => m.isApiErrorMessage !== true).at(-1)
  if (reply === undefined || reply.message.stop_reason !== 'pause_turn') return null
  return Array.isArray(reply.message.content) && reply.message.content.length > 0 ? reply : null
}

type ReasoningOnlyTurn = { reply: AssistantMessage; maxTokens: boolean }

function reasoningOnlyTurnOf(
  assistantMessages: readonly AssistantMessage[],
  refusedToolCalls: number,
): ReasoningOnlyTurn | null {
  if (refusedToolCalls > 0) return null
  const last = assistantMessages.at(-1)
  if (last?.isApiErrorMessage === true && !isWithheldMaxOutputTokens(last)) return null
  const replies = assistantMessages.filter(m => m.isApiErrorMessage !== true)
  const reply = replies.at(-1)
  if (reply === undefined) return null
  const blocks = replies.flatMap(m => (Array.isArray(m.message.content) ? m.message.content : []))
  const isThinking = (block: { type: string }): boolean => block.type === 'thinking' || block.type === 'redacted_thinking'
  const thought = blocks.some(isThinking)
  const silent = blocks.every(
    block => isThinking(block) || (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string' && (block as { text: string }).text.trim() === ''),
  )
  const stamped = replies.some(m => (m as { reasoningOnly?: boolean }).reasoningOnly === true)
  if (!(stamped || (thought && silent))) return null
  if (blocks.some(block => block.type === 'tool_use') || reply.message.stop_reason === 'tool_use') return null
  const maxTokens = isWithheldMaxOutputTokens(last) || reply.message.stop_reason === 'max_tokens'
  return { reply, maxTokens }
}

function outputLimitWords(ceiling: number): string {
  return ceiling % 1000 === 0 ? `${ceiling / 1000}k` : String(ceiling)
}

function withReasoningCutMarker(reply: AssistantMessage): AssistantMessage {
  const content = Array.isArray(reply.message.content) ? reply.message.content : []
  const marker = { type: 'text' as const, text: REASONING_CUT_MARKER, citations: null }
  return { ...reply, message: { ...reply.message, content: [...content, marker] as AssistantMessage['message']['content'] } }
}

function decideMaxOutputTokensRecovery(input: {
  added: boolean
  budgetAllows: boolean
  recoveryCount: number
}): MaxOutputTokensDecision {
  if (!input.added) return { kind: 'surface', why: 'repeat' }
  if (!input.budgetAllows) return { kind: 'surface', why: 'budget' }
  return { kind: 'nudge', attempt: input.recoveryCount + 1 }
}

function replyTextOf(messages: readonly AssistantMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.isApiErrorMessage === true) continue
    for (const block of message.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('')
}

export function readReply(iter: IterationState) {
  const { state, toolUseContext, assistantMessages, refusedToolCalls } = iter
  const lastMessage = assistantMessages.at(-1)
  const chant = iter.streamChant ?? (lastMessage !== undefined && (lastMessage.isApiErrorMessage !== true || isWithheldMaxOutputTokens(lastMessage)) ? detectChant(replyTextOf(assistantMessages)) : null)
  const reasoningOnly = chant === null ? reasoningOnlyTurnOf(assistantMessages, refusedToolCalls.length) : null
  const emptyKind = lastMessage === undefined ? undefined : emptyReplyKindOf(lastMessage)
  const silentAlone =
    emptyKind !== 'empty' &&
    emptyKind !== 'cap' &&
    chant === null &&
    reasoningOnly === null &&
    (state.emptyReplyRecoveryCount ?? 0) < EMPTY_REPLY_RECOVERY_LIMIT &&
    endedWithoutWords(assistantMessages) &&
    runLeftAlone(toolUseContext)
  return { lastMessage, chant, reasoningOnly, emptyKind, silentAlone }
}

export type NoToolReading = ReturnType<typeof readReply>

export type NoToolRule = (run: RunCtx, iter: IterationState, reply: NoToolReading) => AsyncGenerator<RunEvent, SettledDecision | undefined>

async function* overflowRecovery(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit, querySource } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  const { lastMessage } = reply
  const overflowStamped = overflowSignalOf(lastMessage)
  if (overflowStamped !== null && overflowLadderArmed(querySource)) {
    const foldInput = [
      ...messagesForQuery,
      ...assistantMessages.filter(m => m.isApiErrorMessage !== true),
    ]
    const overflow = measureOverflow(overflowStamped, foldInput, toolUseContext.options.engineModel)
    const split = splitCarriedOperatorTail(foldInput)
    const pruneSaving =
      projectTimeBasedMicrocompact(foldInput, querySource, { pressure: true, supersededOnly: true })?.tokensSaved ?? 0
    const decision = decideOverflowRecovery({
      episode: overflowEpisode,
      gapTokens: overflowGapFor(overflow),
      pruneSavingTokens: pruneSaving,
      pruneAllowed: true,
      fold: foldAvailability({ tracking, hasHistory: split.hasHistory }),
    })
    if (decision.kind === 'recover') {
      if (decision.rung === 'fold') {
        yield emit({
          kind: 'notice',
          message: createSystemMessage(overflowRecoveryNotice(overflow, 'fold'), 'warning'),
        })
      }
      const next: NextTurn = {
        messages: foldInput,
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount,
        lastOutputLimitReply: state.lastOutputLimitReply,
        maxOutputTokensOverride,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode: {
          pruned: overflowEpisode.pruned || decision.rung === 'prune',
          folded: overflowEpisode.folded || decision.rung === 'fold',
        },
        pendingOverflow: { signal: overflow, rung: decision.rung },
        transition: { reason: 'overflow_recovery', rung: decision.rung, source: overflow.source },
      }
      return { kind: 'hand_over', next }
    }
    yield emit({
      kind: 'notice',
      message: createAssistantAPIErrorMessage({
        content: overflowRefusalText(overflow, decision.why, {
          nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession),
          ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
        }),
        error: 'invalid_request',
        ...(overflow.detail !== undefined ? { errorDetails: overflow.detail } : {}),
        overflow,
      }),
    })
    const terminal: Terminal = decision.why === 'breaker' && tracking?.rapidRefillPaused === true ? { reason: 'rapid_refill_breaker' } : { reason: 'prompt_too_long' }
    return { kind: 'end', terminal }
  }
}

async function* pauseTurnContinuation(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit, budgetGuard } = run
  const { maxTurns } = run.params
  const { state, messagesForQuery, tracking, assistantMessages } = iter
  const { turnCount } = iter.state
  const paused = pausedReplyOf(assistantMessages)
  if (paused !== null) {
    const pauseTurnContinuations = state.pauseTurnContinuations ?? 0
    const decision = decidePauseTurnContinuation({ continuations: pauseTurnContinuations })
    if (decision.kind === 'continue') {
      const nextTurnCount = turnCount + 1
      if (maxTurns !== undefined && budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)) {
        yield emit({ kind: 'attachment', message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount }) })
        const terminal: Terminal = { reason: 'max_turns', turnCount: nextTurnCount }
        return { kind: 'end', terminal }
      }
      yield emit({
        kind: 'notice',
        message: createSystemMessage(`the provider paused the turn mid-work — sending it back to continue (${decision.attempt} of ${PAUSE_TURN_CONTINUATION_LIMIT}); it counts as a turn`, 'suggestion'),
      })
      const next: NextTurn = {
        ...state,
        messages: [...messagesForQuery, ...assistantMessages.filter(m => m.isApiErrorMessage !== true)],
        autoCompactTracking: tracking,
        turnCount: nextTurnCount,
        pauseTurnContinuations: pauseTurnContinuations + 1,
        stopHookActive: undefined,
        pendingOverflow: undefined,
        transition: { reason: 'pause_turn_continuation', attempt: decision.attempt },
      }
      return { kind: 'hand_over', next }
    }
    yield emit({
      kind: 'notice',
      message: createSystemMessage(`the provider paused the turn ${pauseTurnContinuations} times in a row; the reply stands as it is and the turn ends here`, 'warning'),
    })
  }
}

async function* reasoningOnlyRecovery(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  const { lastMessage, reasoningOnly } = reply
  if (reasoningOnly !== null) {
    const reasoningOnlyRecoveryCount = state.reasoningOnlyRecoveryCount ?? 0
    const decision = decideReasoningOnlyRecovery({ recoveryCount: reasoningOnlyRecoveryCount, maxTokens: reasoningOnly.maxTokens })
    const outputLimit = reasoningOnly.maxTokens
      ? outputLimitWords(reasoningOnly.reply.outputLimit ?? maxOutputTokensOverride ?? getModelMaxOutputTokens(iter.currentModel).default)
      : null
    if (decision.kind === 'continue') {
      const fewerWords = reasoningOnly.maxTokens && decision.attempt >= REASONING_CUT_RECOVERY_LIMIT
      const action = reasoningOnly.maxTokens
        ? fewerWords
          ? 'continuing, asking for fewer words'
          : 'continuing'
        : 'asked it once to say its reply or call the tool it meant'
      yield emit({
        kind: 'notice',
        message: createSystemMessage(reasoningOnlyNoticeLine(outputLimit, decision.attempt > 1, action), 'warning'),
      })
      const nudge = createUserMessage({
        content: reasoningOnlyRecoveryNudge(fewerWords),
        isMeta: true,
      })
      const carried = assistantMessages
        .filter(m => m.isApiErrorMessage !== true)
        .map(m => (reasoningOnly.maxTokens && m === reasoningOnly.reply ? withReasoningCutMarker(m) : m))
      const next: NextTurn = {
        messages: [...messagesForQuery, ...carried, nudge],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount,
        lastOutputLimitReply: state.lastOutputLimitReply,
        maxOutputTokensOverride,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        emptyReplyRecoveryCount: state.emptyReplyRecoveryCount,
        chantRecoveryCount: state.chantRecoveryCount,
        reasoningOnlyRecoveryCount: reasoningOnlyRecoveryCount + 1,
        transition: { reason: 'reasoning_only_recovery', attempt: decision.attempt },
      }
      return { kind: 'hand_over', next }
    }
    const ending = reasoningOnly.maxTokens
      ? `the turn ends here after ${reasoningOnlyRecoveryCount} continuations; the next step is yours`
      : 'the turn ends here'
    yield emit({
      kind: 'notice',
      message: createSystemMessage(reasoningOnlyNoticeLine(outputLimit, true, ending), 'warning'),
    })
    if (isWithheldMaxOutputTokens(lastMessage)) {
      yield emit({ kind: 'withheld_surfaced', message: lastMessage })
    }
  }
}

async function* maxOutputTokensRecovery(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages, refusedToolCalls } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  const { lastMessage, chant, reasoningOnly } = reply
  if (chant === null && reasoningOnly === null && refusedToolCalls.length === 0 && isWithheldMaxOutputTokens(lastMessage)) {
    const replyText = replyTextOf(assistantMessages)
    const maxBudgetUsd = toolUseContext.options.maxBudgetUsd as number | undefined
    const decision = decideMaxOutputTokensRecovery({
      added: continuationAdded(state.lastOutputLimitReply, replyText),
      budgetAllows:
        !toolUseContext.abortController.signal.aborted &&
        (maxBudgetUsd === undefined || getTotalCostUSD() < maxBudgetUsd),
      recoveryCount: maxOutputTokensRecoveryCount,
    })

    if (decision.kind === 'nudge') {
      const recoveryMessage = createUserMessage({
        content: OUTPUT_LIMIT_RECOVERY_TEXT,
        isMeta: true,
      })

      const next: NextTurn = {
        messages: [
          ...messagesForQuery,
          ...assistantMessages,
          recoveryMessage,
        ],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
        lastOutputLimitReply: replyText,
        maxOutputTokensOverride,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        transition: {
          reason: 'max_output_tokens_recovery',
          attempt: decision.attempt,
        },
      }
      return { kind: 'hand_over', next }
    }

    yield emit({
      kind: 'notice',
      message: createSystemMessage(OUTPUT_LIMIT_STOP_WORDS[decision.why], 'warning'),
    })
    yield emit({ kind: 'withheld_surfaced', message: lastMessage })
  }
}

async function* streamFaultRecovery(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  const { lastMessage } = reply
  if (lastMessage && isContinuableStreamFaultMessage(lastMessage)) {
    const decision = decideStreamFaultRecovery({
      continuableTail: true,
      recoveryCount: streamFaultRecoveryCount,
    })
    if (decision.kind === 'continue') {
      const faultText = continuableStreamFaultTextOf(lastMessage)
      const faultFacts = faultText === null ? null : streamFaultFactsOf(faultText)
      yield emit({
        kind: 'notice',
        message: createStreamCutMessage({
          count: decision.attempt,
          content: streamFaultNoticeLine(
            faultText,
            `asked the model to continue from where it stopped (continuation ${decision.attempt} of ${STREAM_FAULT_RECOVERY_LIMIT})`,
          ),
          ...(faultFacts === null ? {} : { road: faultFacts.provider, sent: faultFacts.message, code: faultFacts.code }),
        }),
      })
      const recoveryMessage = createUserMessage({
        content: streamFaultRecoveryContent(replyTextOf(assistantMessages)),
        isMeta: true,
      })
      const next: NextTurn = {
        messages: [...messagesForQuery, ...assistantMessages.filter(m => m.isApiErrorMessage !== true), recoveryMessage],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount,
        lastOutputLimitReply: state.lastOutputLimitReply,
        maxOutputTokensOverride,
        streamFaultRecoveryCount: streamFaultRecoveryCount + 1,
        toolCallRefusalRecoveryCount,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        transition: { reason: 'stream_fault_recovery', attempt: decision.attempt },
      }
      return { kind: 'hand_over', next }
    }
    yield emit({
      kind: 'notice',
      message: createSystemMessage(
        streamFaultNoticeLine(
          continuableStreamFaultTextOf(lastMessage),
          `stopped after ${streamFaultRecoveryCount} continuation${streamFaultRecoveryCount === 1 ? '' : 's'}; the reply so far stands`,
        ),
        'warning',
      ),
    })
  }
}

async function* emptyReplyRetry(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  const { lastMessage, emptyKind, silentAlone } = reply
  if (lastMessage && emptyReplyKindOf(lastMessage) === 'silence' && !silentAlone) {
    const silence = emptyReplyNoteOf(lastMessage) ?? 'the provider finished this response with nothing said; the turn ends here, not cut.'
    yield emit({ kind: 'notice', message: createSystemMessage(silence, 'info') })
  }

  if (emptyKind === 'empty' || silentAlone) {
    const emptyReplyRecoveryCount = state.emptyReplyRecoveryCount ?? 0
    const decision = decideEmptyReplyRecovery({ recoveryCount: emptyReplyRecoveryCount })
    if (decision.kind === 'continue') {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          emptyReplyNoticeLine(`asked the model for its answer (retry ${decision.attempt} of ${EMPTY_REPLY_RECOVERY_LIMIT})`),
          'warning',
        ),
      })
      const nudge = createUserMessage({
        content: EMPTY_REPLY_RECOVERY_NUDGE,
        isMeta: true,
      })
      const next: NextTurn = {
        messages: endsWithEmptyReplyRecoveryNudge(messagesForQuery) ? messagesForQuery : [...messagesForQuery, nudge],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount,
        lastOutputLimitReply: state.lastOutputLimitReply,
        maxOutputTokensOverride,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        emptyReplyRecoveryCount: emptyReplyRecoveryCount + 1,
        transition: { reason: 'empty_reply_retry', attempt: decision.attempt },
      }
      return { kind: 'hand_over', next }
    }
    yield emit({
      kind: 'notice',
      message: createSystemMessage(emptyReplyEndedLine(emptyReplyRecoveryCount), 'warning'),
    })
  }
}

async function* toolCallRefusalRecovery(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit, holdMemoryWriteRefusals, memoryWriteLostEvent } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages, allRefusedToolCalls, refusedToolCalls } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  if (refusedToolCalls.length > 0) {
    const decision = decideToolCallRefusalRecovery({
      refusals: refusedToolCalls.length,
      recoveryCount: toolCallRefusalRecoveryCount,
    })
    if (decision.kind === 'continue') {
      const names = [...new Set(refusedToolCalls.map(r => r.name || 'unnamed'))].join(', ')
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          `Tool call refused before execution (${names}) — asking the model to correct it (${decision.attempt}/${TOOL_CALL_REFUSAL_RECOVERY_LIMIT}).`,
          'warning',
        ),
      })
      holdMemoryWriteRefusals(allRefusedToolCalls)
      const correction = createUserMessage({
        content: toolCallRefusalCorrection(refusedToolCalls),
        isMeta: true,
      })
      const next: NextTurn = {
        messages: [...messagesForQuery, ...assistantMessages, correction],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount,
        lastOutputLimitReply: state.lastOutputLimitReply,
        maxOutputTokensOverride,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount: toolCallRefusalRecoveryCount + 1,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        transition: { reason: 'tool_call_refusal_recovery', attempt: decision.attempt },
      }
      return { kind: 'hand_over', next }
    }
    const tools = [...new Set(refusedToolCalls.map(r => r.name || 'unnamed'))]
    yield emit({
      kind: 'notice',
      message: createSystemMessage(
        `Tool call refused before execution (${tools.join(', ')}) — the model was asked to correct it ${toolCallRefusalRecoveryCount} times and could not; the turn ends without an answer.`,
        'error',
      ),
    })
    holdMemoryWriteRefusals(allRefusedToolCalls)
    const lost = memoryWriteLostEvent()
    if (lost !== null) yield lost
    const terminal: Terminal = { reason: 'tool_calls_refused', tools, corrections: toolCallRefusalRecoveryCount }
    return { kind: 'end', terminal }
  }
}

async function* chantRecovery(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { maxOutputTokensRecoveryCount, maxOutputTokensOverride, streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  const { lastMessage, chant } = reply
  if (chant !== null) {
    const chantRecoveryCount = state.chantRecoveryCount ?? 0
    const decision = decideChantRecovery({ recoveryCount: chantRecoveryCount })
    if (iter.streamChant === undefined) yield* trimChantedIteration(iter, chant, emit)
    const replyMessages = assistantMessages.filter(m => m.isApiErrorMessage !== true)
    if (decision.kind === 'continue') {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          iter.streamChant !== undefined
            ? requestWaitLine({ kind: 'retry', attempt: decision.attempt, of: CHANT_RECOVERY_LIMIT, reason: 'the reply repeated itself', delayMs: 0, sinceMs: Date.now() })
            : chantNoticeLine(chant, `asked the model to continue past it (continuation ${decision.attempt} of ${CHANT_RECOVERY_LIMIT})`),
          'warning',
        ),
      })
      const nudge = createUserMessage({ content: chantNudgeText(chant), isMeta: true })
      const next: NextTurn = {
        messages: [...messagesForQuery, ...replyMessages, nudge],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount,
        lastOutputLimitReply: state.lastOutputLimitReply,
        maxOutputTokensOverride,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        emptyReplyRecoveryCount: state.emptyReplyRecoveryCount,
        chantRecoveryCount: chantRecoveryCount + 1,
        transition: { reason: 'chant_recovery', attempt: decision.attempt },
      }
      return { kind: 'hand_over', next }
    }
    const chantEnds = isLoopGuardStopEnabled() ? LOOP_GUARD_STOP_SETTING : runLeftAlone(toolUseContext) ? 'nobody is at this run' : null
    if (chantEnds !== null) {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          chantNoticeLine(chant, `the reply repeated itself again after the loop notice; the turn is ended (${chantEnds})`),
          'warning',
        ),
      })
      yield emit({
        kind: 'attachment',
        message: createAttachmentMessage({
          type: 'loop_stopped',
          toolUseID: '',
          cycle: ['reply'],
          message: chantStopText(chant),
        }),
      })
      const terminal: Terminal = { reason: 'loop_stopped', cycle: ['reply'] }
      return { kind: 'end', terminal }
    }
    yield emit({
      kind: 'notice',
      message: createSystemMessage(
        chantNoticeLine(chant, `the reply repeated itself again after the loop notice; the reply stands, and the loop guard ends no turn without ${LOOP_GUARD_STOP_SETTING}`),
        'warning',
      ),
    })
    if (isWithheldMaxOutputTokens(lastMessage)) {
      yield emit({ kind: 'withheld_surfaced', message: lastMessage })
    }
  }
}

async function* turnBudgetSpent(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit, memoryWriteLostEvent } = run
  const { maxTurns } = run.params
  const { closingTurn } = iter
  const { turnCount } = iter.state
  if (closingTurn && maxTurns !== undefined) {
    yield emit({
      kind: 'attachment',
      message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount }),
    })
    const lostAtCap = memoryWriteLostEvent()
    if (lostAtCap !== null) yield lostAtCap
    const terminal: Terminal = { reason: 'max_turns', turnCount }
    return { kind: 'end', terminal }
  }
}

async function* apiErrorReply(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit, memoryWriteLostEvent } = run
  const { messagesForQuery } = iter
  const { lastMessage } = reply
  if (lastMessage?.isApiErrorMessage) {
    const sizeWarning = requestSizeWarningApplies(lastMessage) ? requestSizeWarning(messagesForQuery, iter.currentModel) : null
    if (sizeWarning !== null) {
      yield emit({ kind: 'notice', message: createSystemMessage(sizeWarning, 'warning') })
    }
    const lostOnError = memoryWriteLostEvent()
    if (lostOnError !== null) yield lostOnError
    const terminal: Terminal = { reason: 'completed' }
    return { kind: 'end', terminal }
  }
}

async function* announcedStepNudge(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { state, toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { lastMessage, chant, reasoningOnly } = reply
  if (
    chant === null &&
    reasoningOnly === null &&
    lastMessage !== undefined &&
    lastMessage.message.stop_reason === 'end_turn' &&
    runLeftAlone(toolUseContext) &&
    announcesNextStep(replyTextOf(assistantMessages))
  ) {
    if (run.announcedStepNudges < ANNOUNCED_STEP_NUDGE_LIMIT) {
      run.announcedStepNudges++
      yield emit({ kind: 'notice', message: createSystemMessage(ANNOUNCED_STEP_NOTICE, 'warning') })
      const next: NextTurn = {
        ...state,
        messages: [
          ...messagesForQuery,
          ...assistantMessages.filter(m => m.isApiErrorMessage !== true),
          createUserMessage({ content: ANNOUNCED_STEP_NUDGE, isMeta: true }),
        ],
        toolUseContext,
        autoCompactTracking: tracking,
        stopHookActive: undefined,
        overflowEpisode,
        pendingOverflow: undefined,
        transition: { reason: 'announced_step_nudge', attempt: run.announcedStepNudges },
      }
      return { kind: 'hand_over', next }
    }
    yield emit({ kind: 'notice', message: createSystemMessage(ANNOUNCED_STEP_AGAIN_NOTICE, 'warning') })
  }
}

async function* stopHooks(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit, querySource, systemPrompt, userContext, systemContext } = run
  const { toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { streamFaultRecoveryCount, toolCallRefusalRecoveryCount, stopHookActive, turnCount } = iter.state
  const stopHookResult = yield* runStopHookGate(
    handleStopHooks(
      messagesForQuery,
      assistantMessages,
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext,
      querySource,
      stopHookActive,
    ),
    emit,
  )

  if (stopHookResult.preventContinuation) {
    const terminal: Terminal = { reason: 'stop_hook_prevented' }
    return { kind: 'end', terminal }
  }

  if (stopHookResult.blockingErrors.length > 0) {
    const next: NextTurn = {
      messages: [
        ...messagesForQuery,
        ...assistantMessages,
        ...stopHookResult.blockingErrors,
      ],
      toolUseContext,
      autoCompactTracking: tracking,
      maxOutputTokensRecoveryCount: 0,
      streamFaultRecoveryCount,
      toolCallRefusalRecoveryCount,
      maxOutputTokensOverride: undefined,
      stopHookActive: true,
      turnCount,
      overflowEpisode,
      pendingOverflow: undefined,
      transition: { reason: 'stop_hook_blocking' },
    }
    return { kind: 'hand_over', next }
  }
}

async function* checkpointSettleGuard(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { toolUseContext, messagesForQuery, tracking, overflowEpisode, assistantMessages } = iter
  const { streamFaultRecoveryCount, toolCallRefusalRecoveryCount, turnCount } = iter.state
  if (!run.checkpointSettleWarned) {
    const liveCheckpoint = findActiveCheckpoint([
      ...messagesForQuery,
      ...assistantMessages,
    ])
    if (liveCheckpoint !== null) {
      run.checkpointSettleWarned = true
      const warning = createSettleGuardWarning(liveCheckpoint)
      yield emit({ kind: 'attachment', message: warning })
      const next: NextTurn = {
        messages: [...messagesForQuery, ...assistantMessages, warning],
        toolUseContext,
        autoCompactTracking: tracking,
        maxOutputTokensRecoveryCount: 0,
        streamFaultRecoveryCount,
        toolCallRefusalRecoveryCount,
        maxOutputTokensOverride: undefined,
        stopHookActive: undefined,
        turnCount,
        overflowEpisode,
        pendingOverflow: undefined,
        transition: { reason: 'checkpoint_settle_guard' },
      }
      return { kind: 'hand_over', next }
    }
  }
}

async function* queuedMessage(run: RunCtx, iter: IterationState, reply: NoToolReading): AsyncGenerator<RunEvent, SettledDecision | undefined> {
  const { emit } = run
  const { toolUseContext, messagesForQuery, tracking, assistantMessages } = iter
  const { turnCount } = iter.state
  const queued = getAgentPendingMessageAttachments(toolUseContext).map(attachment => createAttachmentMessage(attachment))
  if (queued.length > 0) {
    for (const row of queued) yield emit({ kind: 'attachment', message: row })
    const next: NextTurn = {
      messages: [...messagesForQuery, ...assistantMessages, ...queued],
      toolUseContext,
      autoCompactTracking: tracking,
      turnCount: turnCount + 1,
      maxOutputTokensRecoveryCount: 0,
      streamFaultRecoveryCount: 0,
      toolCallRefusalRecoveryCount: 0,
      maxOutputTokensOverride: undefined,
      stopHookActive: undefined,
      overflowEpisode: FRESH_OVERFLOW_EPISODE,
      pendingOverflow: undefined,
      transition: { reason: 'queued_message', count: queued.length },
    }
    return { kind: 'hand_over', next }
  }
}

export async function* replyStands(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, SettledDecision> {
  const { emit, querySource, memoryWriteLostEvent, systemPrompt, userContext, systemContext } = run
  const { canUseTool } = run.params
  const { toolUseContext, messagesForQuery, assistantMessages } = iter
  await finishMemorySignal(assistantText(assistantMessages))
  if (handoffAskDue({ agentId: toolUseContext.agentId, querySource })) {
    let closeUsage: import('../../services/api/emptyUsage.js').NonNullableUsage | undefined
    const beforeNote = ledgerMark()
    const note = await askForHandoff({
      cacheSafeParams: createCacheSafeParams({
        messages: [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      }),
      signal: toolUseContext.abortController.signal,
      canUseTool,
      onUsage: usage => { closeUsage = usage },
    })
    yield emit({
      kind: 'notice',
      message: createCloseUsageMessage({
        closeState: note === null ? 'none' : note.stored ? 'stored' : 'skipped',
        ...(note?.text !== undefined ? { noteChars: note.text.length } : {}),
        ...(closeUsage !== undefined ? { usage: closeUsage } : {}),
        spent: ledgerSpentSince(beforeNote),
      }),
    })
    if (note?.stored === false) {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          handoffNotice(note),
          'warning',
        ),
      })
    }
  }

  const lostAtEnd = memoryWriteLostEvent()
  if (lostAtEnd !== null) yield lostAtEnd
  const terminal: Terminal = { reason: 'completed' }
  return { kind: 'end', terminal }
}

export const NO_TOOL_RULES: ReadonlyArray<{ name: string; decide: NoToolRule }> = [
  { name: 'overflow_recovery', decide: overflowRecovery },
  { name: 'pause_turn_continuation', decide: pauseTurnContinuation },
  { name: 'reasoning_only_recovery', decide: reasoningOnlyRecovery },
  { name: 'max_output_tokens_recovery', decide: maxOutputTokensRecovery },
  { name: 'stream_fault_recovery', decide: streamFaultRecovery },
  { name: 'empty_reply_retry', decide: emptyReplyRetry },
  { name: 'tool_call_refusal_recovery', decide: toolCallRefusalRecovery },
  { name: 'chant_recovery', decide: chantRecovery },
  { name: 'max_turns', decide: turnBudgetSpent },
  { name: 'api_error', decide: apiErrorReply },
  { name: 'announced_step_nudge', decide: announcedStepNudge },
  { name: 'stop_hooks', decide: stopHooks },
  { name: 'checkpoint_settle_guard', decide: checkpointSettleGuard },
  { name: 'queued_message', decide: queuedMessage },
]

export async function* noToolReply(run: RunCtx, iter: IterationState): AsyncGenerator<RunEvent, TurnDecision> {
  if (iter.needsFollowUp) return { kind: 'go_on' }
  iter.early.reset()
  const reply = readReply(iter)
  for (const rule of NO_TOOL_RULES) {
    const decision = yield* rule.decide(run, iter, reply)
    if (decision !== undefined) return decision
  }
  return yield* replyStands(run, iter)
}
