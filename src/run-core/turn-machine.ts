import type { ToolResultBlockParam, ToolUseBlock } from '../types/wire.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import { backupEngineNoticeLine, engineLadderOf } from '../services/api/backupEngines.js'
import { resetSessionEnvNoticeOnCompaction } from '../tools/shared/sessionEnvNotice.js'
import {
  AUTOCOMPACT_THRASH_MESSAGE,
  rapidRefillPauseText,
  calculateTokenWarningState,
  getBlockingLimit,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from '../services/compact/autoCompact.js'
import { buildPostCompactMessages } from '../services/compact/compact.js'
import { estimateContextTokens, projectTimeBasedMicrocompact } from '../services/compact/microCompact.js'
import { fireHooks } from '../utils/hooks/fire.js'
import { hookRowsOfResult } from '../utils/hooks/rows.js'
import { getSessionId } from '../bootstrap/state.js'
import {
  classifyThinkingDrops,
  createDeadThinkingAttachment,
  deadMarksFromDrops,
  deadThinkingMarks,
  describePrefixRewrite,
  describeThinkingDrops,
  turnOrdinalOfWirePath,
  inputTransformationsOf,
  modelSwitchReceipt,
  prefixMarkOf,
  recordPrefixRewriteLedger,
  recordThinkingDropLedger,
  takeRewriteNoticeOnce,
} from '../services/providers/anthropic/thinkingBinding.js'
import { recordDroppedThinking, takePrefixVerdict, pendingPrefixVerdict } from '../services/providers/anthropic/prefixLedger.js'
import { foldCacheUsage } from '../services/compact/cacheEpoch.js'
import { boundPrefixRecordToEmit } from '../services/providers/anthropic/boundPrefixRecord.js'
import { logForDebugging } from '../utils/debug.js'

const switchReceipts = new Set<string>()

const responsesClassified = new Set<string>()
const streamEndsReceipted = new Set<string>()
const effortAdjustmentsReceipted = new Set<string>()
const busyRecoveriesReceipted = new Set<string>()
const RESPONSES_CLASSIFIED_CAP = 64
function rememberClassifiedResponse(id: string): void {
  responsesClassified.add(id)
  while (responsesClassified.size > RESPONSES_CLASSIFIED_CAP) {
    const oldest = responsesClassified.values().next().value
    if (oldest === undefined) break
    responsesClassified.delete(oldest)
  }
}
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
  foldRemedyIsHeadless,
  splitCarriedOperatorTail,
  type OverflowEpisode,
  type OverflowRung,
} from '../services/compact/overflowRecovery.js'
import {
  estimateOverflowSignal,
  overflowSignalOf,
  type OverflowSignal,
} from '../services/api/overflowSignal.js'
import { ImageSizeError } from '../utils/imageValidation.js'
import { ImageResizeError, imagesLeftOutMarked, imagesLeftOutNoticeLine, takeImagesLeftOutReceipt } from '../utils/imageResizer.js'
import { describeInvalidArgTypeError } from '../utils/errors.js'
import { advanceToolCallChain, findToolByName, type ToolCallChain, type ToolUseContext } from '../Tool.js'
import {
  effortAdjustedReceiptLine,
  isTurnOwningQuerySource,
} from '../utils/effort.js'
import { asSystemPrompt, type SystemPrompt } from '../utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ReplyMark,
  ToolUseSummaryMessage,
  UserMessage,
  RefusedToolCall,
} from '../types/message.js'
import { logError } from '../utils/log.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  EMPTY_REPLY_RECOVERY_NUDGE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  continuableStreamFaultTextOf,
  endsWithEmptyReplyRecoveryNudge,
  isContinuableStreamFaultMessage,
  REASONING_CUT_MARKER,
  reasoningOnlyNoticeLine,
  reasoningOnlyRecoveryNudge,
  streamFaultFactsOf,
  streamFaultNoticeLine,
  streamFaultRecoveryContent,
} from '../services/api/errors.js'
import {
  collectRefusedToolCalls,
  unansweredRefusals,
  memoryWriteLostNotice,
  memoryWriteRefusals,
  settleMemoryWriteRefusals,
  toolCallRefusalCorrection,
} from '../services/providers/toolCallGate.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createCloseUsageMessage,
  createStreamCutMessage,
  createBusyRecoveryMessage,
  createThinkingNoteMessage,
  createAssistantAPIErrorMessage,
  createToolUseSummaryMessage,
} from '../utils/messages.js'
import { generateToolUseSummary } from '../services/toolUseSummary/toolUseSummaryGenerator.js'
import {
  CHANT_RECOVERY_LIMIT,
  chantNoticeLine,
  chantNudgeText,
  chantStopText,
  decideChantRecovery,
  detectChant,
  StreamChantWatch,
  trimChantedReplyMessages,
  type ChantDetection,
} from '../services/tools/chantGuard.js'
import { isLoopGuardStopEnabled, LOOP_GUARD_STOP_SETTING } from '../services/tools/loopGuard.js'
import {
  buildRewindRecordIfSettled,
  createSettleGuardWarning,
  findActiveCheckpoint,
} from '../services/compact/checkpointRewind.js'
import { prependUserContext, appendSystemContext } from '../utils/api.js'
import { latestUserContextBody } from '../utils/attachments/userContext.js'
import {
  createAttachmentMessage,
  getAgentPendingMessageAttachments,
  getAttachmentMessages,
} from '../utils/attachments.js'
import {
  remove as removeFromQueue,
  getDrainableCommands,
  markDraining,
  isSlashCommand,
} from '../utils/messageQueueManager.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from '../utils/headlessProfiler.js'
import { getModelMaxOutputTokens } from '../utils/model/capabilities.js'
import {
  tokenCountWithEstimation,
} from '../utils/tokens.js'
import { getTotalCostUSD } from '../bootstrap/state.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import type { QuerySource } from '../constants/querySource.js'
import { runTools } from '../services/tools/toolOrchestration.js'
import { EarlyStarts } from '../services/tools/earlyStarts.js'
import { emitCompactionTrace } from '../utils/observability/invocationTrace.js'
import { flushSessionStorage, recordContentReplacement } from '../utils/sessionStorage.js'
import { handleStopHooks } from '../query/stopHooks.js'
import { buildRequestContextPlan, reconcileAppliedPlanUsage, type RequestContextPlan } from '../services/run/requestContextPlan.js'
import { calibrationKeyFor } from '../services/run/contextCalibration.js'
import { randomUUID, type UUID } from 'node:crypto'
import { bindRequestGauge, requestGaugeFixed, settleRequestGauge } from '../services/run/requestGauge.js'
import { outputRoomOf } from '../services/api/outputFit.js'
import { getContextEpoch } from '../services/run/contextEpochs.js'
import { ERROR_MESSAGE_USER_ABORT } from '../services/compact/compact.js'
import { toolToAPISchema } from '../utils/api.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { requestWaitLine, streamEndReceiptLine } from '../services/providers/streamIdleBudget.js'
import { interruptedToolsLine, turnCutOf, turnCutResultText, type TurnCut } from '../utils/messages/rejectionText.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../services/run/resolveOwner.js'
import { planToolPayloadUnseeded, toolsOnTheWire } from '../services/providers/toolEconomy.js'
import { localPromptFitRefusal, localPromptFits } from '../services/providers/local/localCallModel.js'
import { createCacheSafeParams, recordSentRequest } from '../utils/forkedAgent.js'
import { askForHandoff, assistantText, handoffAskDue, handoffNotice } from '../mneme/handoffAsk.js'
import { finishMemorySignal, memorySignalScope } from '../mneme/mnemeSignal.js'
import { emptyReplyEndedLine, emptyReplyKindOf, emptyReplyNoteOf, emptyReplyNoticeLine } from '../services/providers/emptyReply.js'
import { buildQueryConfig, type QueryConfig } from '../query/config.js'
import { productionDeps, type QueryDeps } from '../query/deps.js'
import type { Terminal, Continue } from '../query/transitions.js'
import { BudgetGuard } from './budget-guard.js'
import {
  backfillCloneForYield,
  isWithheldMaxOutputTokens,
  resetForRetry,
} from './model-lane.js'
import {
  consumeDrainedCommands,
  replyMarkOf,
  selectDrainableCommands,
  stampReply,
} from './attachment-drain.js'
import { buildModelCallReference } from './call-reference.js'
import { createEventMint, type RunEvent } from './events.js'
import { operatorPauseGate, pauseGateKeyOf, pauseGateModelWords, pauseGateSeatOf } from './pauseGate.js'
import { acquireModelPermit, releaseModelPermitByCall } from '../services/capacity/governor.js'
import { refreshGovernorCeilings } from '../services/capacity/composeCeilings.js'

const OUTPUT_LIMIT_RECOVERY_TEXT =
  'The reply hit the output ceiling. Carry on from exactly where it stopped — no recap, no apology — in smaller pieces.'

const OUTPUT_LIMIT_STOP_WORDS = {
  repeat: 'the reply hit the output ceiling and the continuation repeated what already stood; the turn ends here',
  budget: "the reply hit the output ceiling and the run's budget is spent; the turn ends here",
} as const

export const MAX_TURNS_CLOSING_TEXT =
  'The turn budget is spent: no further tool call will run. Answer in text only — what was done, what was found, and what remains.'

const MAX_TURNS_CUT: TurnCut = { kind: 'cut', detail: 'the turn budget was spent' }

function continuationAdded(previous: string | undefined, next: string): boolean {
  if (previous === undefined) return true
  const added = next.trim()
  if (added === '') return false
  const stood = previous.trim()
  if (added === stood) return false
  return stood.length < 80 || !added.includes(stood.slice(-80))
}

function refreshTurnTools(context: ToolUseContext): ToolUseContext {
  const { options } = context
  if (!options.refreshTools) return context
  const tools = options.refreshTools()
  if (tools === options.tools) return context
  return { ...context, options: { ...options, tools } }
}

type EventMint = ReturnType<typeof createEventMint>

type ContextFacts = Record<string, string>

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: ContextFacts
  systemContext: ContextFacts
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  deps?: QueryDeps
}


type TurnState = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  lastOutputLimitReply?: string
  maxOutputTokensOverride: number | undefined
  streamFaultRecoveryCount: number
  toolCallRefusalRecoveryCount: number
  cutToolCallRecoveryCount?: number
  pauseTurnContinuations?: number
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
  emptyReplyRecoveryCount?: number
  chantRecoveryCount?: number
  reasoningOnlyRecoveryCount?: number
  overflowEpisode: OverflowEpisode
  pendingOverflow: { signal: OverflowSignal; rung: OverflowRung } | undefined
}


type RunCtx = {
  params: QueryParams
  userContext: { [k: string]: string }
  fallbackModel: string | undefined
  querySource: QuerySource
  skipCacheWrite: boolean | undefined
  deps: QueryDeps
  config: QueryConfig
  budgetGuard: BudgetGuard
}


type IterationState = {
  turnId: string
  ordinal: number
  requestPlan: RequestContextPlan
  messagesForQuery: Message[]
  toolUseContext: ToolUseContext
  callChain: ToolCallChain
  chainIdForAnalytics: string
  tracking: AutoCompactTrackingState | undefined
  fullSystemPrompt: SystemPrompt
  appState: ReturnType<ToolUseContext['getAppState']>
  currentModel: string
  maxOutputTokensOverride: number | undefined
  assistantMessages: AssistantMessage[]
  toolResults: (UserMessage | AttachmentMessage)[]
  deadThinkingRecords: AttachmentMessage[]
  toolUseBlocks: ToolUseBlock[]
  needsFollowUp: boolean
  closingTurn: boolean
  callOrdinal: number
  replyTo: ReplyMark[]
  early: EarlyStarts
  streamChant?: ChantDetection
}


function* emitSyntheticSettlements(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
  outcome: 'error' | 'aborted',
  emit: EventMint,
): Generator<RunEvent> {
  for (const assistantMessage of assistantMessages) {
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    for (const toolUse of toolUseBlocks) {
      yield emit({
        kind: 'tool_settled',
        toolUseId: toolUse.id,
        outcome,
        synthetic: true,
        message: createUserMessage({
          content: [
            {
              type: 'tool_result',
              content: errorMessage,
              is_error: true,
              tool_use_id: toolUse.id,
            },
          ],
          toolUseResult: errorMessage,
          sourceToolAssistantUUID: assistantMessage.uuid,
        }),
      })
    }
  }
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

const STREAM_FAULT_RECOVERY_LIMIT = 1

const TOOL_CALL_REFUSAL_RECOVERY_LIMIT = 3

type StreamFaultDecision = { kind: 'continue'; attempt: number } | { kind: 'surface' }

export function decideToolCallRefusalRecovery(input: {
  refusals: number
  recoveryCount: number
}): StreamFaultDecision {
  if (input.refusals > 0 && input.recoveryCount < TOOL_CALL_REFUSAL_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

const CUT_TOOL_CALL_RECOVERY_LIMIT = 2

export type CutToolCallDecision = { kind: 'retry'; attempt: number; outputTokens: number } | { kind: 'surface' }

export function decideCutToolCallRecovery(input: {
  recoveryCount: number
  sentCap: number | undefined
  cutAt: number
  upperLimit: number
  room: number
  routeTakesCap: boolean
}): CutToolCallDecision {
  if (!input.routeTakesCap || input.recoveryCount >= CUT_TOOL_CALL_RECOVERY_LIMIT) return { kind: 'surface' }
  if (![input.sentCap ?? 0, input.cutAt, input.upperLimit, input.room].every(Number.isFinite)) return { kind: 'surface' }
  const base = Math.max(input.sentCap ?? 0, input.cutAt, 1)
  const ceiling = Math.min(input.upperLimit, input.room > 0 ? input.room : input.upperLimit)
  const outputTokens = Math.min(base * 2, ceiling)
  if (outputTokens <= base) return { kind: 'surface' }
  return { kind: 'retry', attempt: input.recoveryCount + 1, outputTokens }
}

function cutToolCallOf(assistantMessages: readonly AssistantMessage[], refused: readonly RefusedToolCall[]): { name: string; cutAt: number } | null {
  const cut = refused.find(r => r.code === 'invalid-json')
  if (cut === undefined) return null
  const replies = assistantMessages.filter(m => m.isApiErrorMessage !== true)
  const stopped = assistantMessages.some(isWithheldMaxOutputTokens) || replies.some(m => m.message.stop_reason === 'max_tokens')
  if (!stopped) return null
  const cutAt = Math.max(0, ...replies.map(m => m.message.usage?.output_tokens ?? 0))
  return { name: cut.name || 'unnamed', cutAt }
}

export const PAUSE_TURN_CONTINUATION_LIMIT = 8

export function decidePauseTurnContinuation(input: { continuations: number }): StreamFaultDecision {
  if (input.continuations < PAUSE_TURN_CONTINUATION_LIMIT) return { kind: 'continue', attempt: input.continuations + 1 }
  return { kind: 'surface' }
}

function pausedReplyOf(assistantMessages: readonly AssistantMessage[]): AssistantMessage | null {
  const reply = assistantMessages.filter(m => m.isApiErrorMessage !== true).at(-1)
  if (reply === undefined || reply.message.stop_reason !== 'pause_turn') return null
  return Array.isArray(reply.message.content) && reply.message.content.length > 0 ? reply : null
}

const EMPTY_REPLY_RECOVERY_LIMIT = 1

const REASONING_ONLY_RECOVERY_LIMIT = 1

const REASONING_CUT_RECOVERY_LIMIT = 2

export function decideReasoningOnlyRecovery(input: { recoveryCount: number; maxTokens: boolean }): StreamFaultDecision {
  const limit = input.maxTokens ? REASONING_CUT_RECOVERY_LIMIT : REASONING_ONLY_RECOVERY_LIMIT
  if (input.recoveryCount < limit) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
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

export function decideEmptyReplyRecovery(input: { recoveryCount: number }): StreamFaultDecision {
  if (input.recoveryCount < EMPTY_REPLY_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

export function decideStreamFaultRecovery(input: {
  continuableTail: boolean
  recoveryCount: number
}): StreamFaultDecision {
  if (input.continuableTail && input.recoveryCount < STREAM_FAULT_RECOVERY_LIMIT) {
    return { kind: 'continue', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
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


function* trimChantedIteration(iter: IterationState, detection: ChantDetection, emit: EventMint): Generator<RunEvent> {
  const cleaned = trimChantedReplyMessages(iter.assistantMessages, detection)
  for (const message of iter.assistantMessages) {
    if (!cleaned.includes(message)) yield emit({ kind: 'assistant_retracted', message })
  }
  for (const message of cleaned) {
    if (!iter.assistantMessages.includes(message)) yield emit({ kind: 'assistant_settled', callId: `${iter.turnId}.c${iter.callOrdinal}`, message, withheld: false })
  }
  iter.assistantMessages.splice(0, iter.assistantMessages.length, ...cleaned)
}

type StreamOutcome =
  | { kind: 'streamed' }
  | { kind: 'terminal'; terminal: Terminal }

async function* streamModel(
  run: RunCtx,
  iter: IterationState,
  emit: EventMint,
): AsyncGenerator<RunEvent, StreamOutcome> {
  const { toolUseContext, callChain } = iter
  const backups = engineLadderOf(run, run.fallbackModel)
  let attemptWithFallback = true

  try {
    while (attemptWithFallback) {
      attemptWithFallback = false
      if (operatorPauseGate.holds(pauseGateKeyOf(toolUseContext))) {
        toolUseContext.onSeatWait?.(pauseGateModelWords())
        await operatorPauseGate.park(toolUseContext.abortController.signal, pauseGateSeatOf(toolUseContext), pauseGateKeyOf(toolUseContext))
        toolUseContext.onSeatWait?.(null)
        if (toolUseContext.abortController.signal.aborted) return { kind: 'streamed' }
      }
      const callId = `${iter.turnId}.c${++iter.callOrdinal}`
      const permitKey = `${iter.callChain.key}:${callId}`
      refreshGovernorCeilings(iter.currentModel, iter.appState.effortValue)
      let permit: Awaited<ReturnType<typeof acquireModelPermit>>
      try {
        permit = await acquireModelPermit({
          lane:
            toolUseContext.agentId !== undefined
              ? 'background-session'
              : isTurnOwningQuerySource(run.querySource)
                ? 'foreground'
                : 'service',
          callId: permitKey,
          ...(toolUseContext.seatHolder !== undefined ? { holder: toolUseContext.seatHolder } : {}),
          signal: toolUseContext.abortController.signal,
          ...(toolUseContext.onSeatWait !== undefined ? { onWait: toolUseContext.onSeatWait } : {}),
        })
      } catch (waitError) {
        if (toolUseContext.abortController.signal.aborted) return { kind: 'streamed' }
        throw waitError
      }
      yield emit({
        kind: 'model_permit',
        callId,
        lane: permit.lane,
        waitedMs: permit.waitedMs,
        reacquired: permit.reacquired,
      })
      const effortValue = iter.appState.effortValue
      const callReference = buildModelCallReference({
        model: iter.currentModel,
        effort: effortValue,
        maxOutputTokensOverride: iter.maxOutputTokensOverride,
        tools: toolUseContext.options.tools,
      })
      yield emit({
        kind: 'model_call_started',
        callId,
        model: iter.currentModel,
        effort: effortValue,
        maxOutputTokensOverride: iter.maxOutputTokensOverride,
        reference: callReference,
      })
      {
        const receipt = modelSwitchReceipt(
          String(ownerFromToolUseContext(toolUseContext)),
          iter.messagesForQuery,
          iter.currentModel,
        )
        if (receipt !== null && !switchReceipts.has(receipt.key)) {
          switchReceipts.add(receipt.key)
          logForDebugging(`preserved thinking: ${receipt.text}`)
          yield emit({ kind: 'notice', message: createSystemMessage(receipt.text, 'suggestion') })
        }
      }
      const streamController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      const onAbort = (): void => streamController.abort(parentSignal.reason)
      parentSignal.addEventListener('abort', onAbort, { once: true })
      if (parentSignal.aborted) onAbort()
      let chantWatch = new StreamChantWatch()
      try {
        let streamingFallbackOccured = false
        const requestMessages =
          latestUserContextBody(iter.messagesForQuery) === null
            ? prependUserContext(iter.messagesForQuery, run.userContext)
            : iter.messagesForQuery
        if (isTurnOwningQuerySource(run.querySource)) {
          recordSentRequest(String(rosterOwnerFromToolUseContext(toolUseContext)), requestMessages)
        }
        const requestGauge = iter.requestPlan.gauge === undefined ? undefined : bindRequestGauge(
          iter.messagesForQuery,
          calibrationKeyFor(declaredRouteOf(iter.currentModel) ?? 'unrecognised', iter.currentModel),
          getContextEpoch(ownerFromToolUseContext(toolUseContext)).epoch,
          iter.requestPlan.gauge.fixed,
          iter.requestPlan.gauge.rebase,
        )
        if (requestGauge !== undefined && requestGauge.digest === iter.requestPlan.gauge?.digest) requestGauge.sourceDigest = iter.requestPlan.gauge.sourceDigest
        const projectedReplies = new Map<string, AssistantMessage>()
        let fixedPrefix: import('../services/providers/anthropic/prefixLedger.js').PrefixVerdict['fixedPrefix']
        const settleGauge = (message: AssistantMessage): void => {
          if (!requestGauge || message.contextGauge) return
          const anchor = settleRequestGauge(requestGauge, message)
          if (!anchor) return
          const boundary = iter.messagesForQuery.findLast(row => row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.cacheEpoch !== undefined)
          if (boundary?.type === 'system' && boundary.subtype === 'compact_boundary' && !iter.messagesForQuery.some(row => row.type === 'assistant' && row.foldLanding?.boundaryId === boundary.uuid)) {
            const usage = foldCacheUsage(message.message.usage)
            if (usage) message.foldLanding = { boundaryId: boundary.uuid, usage, fixedPrefix: fixedPrefix ?? pendingPrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))?.fixedPrefix }
          }
          const projected = projectedReplies.get(message.uuid)
          if (projected) { projected.contextGauge = anchor; projected.foldLanding = message.foldLanding }
          if (callId === `${iter.turnId}.c1`) {
            const u = message.message.usage
            reconcileAppliedPlanUsage(ownerFromToolUseContext(toolUseContext), (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
          }
        }
        for await (const message of run.deps.callModel({
          messages: requestMessages,
          systemPrompt: iter.fullSystemPrompt,
          thinkingConfig: toolUseContext.options.thinkingConfig,
          tools: toolUseContext.options.tools,
          signal: streamController.signal,
          options: {
            async getToolPermissionContext() {
              const appState = toolUseContext.getAppState()
              return appState.toolPermissionContext
            },
            model: iter.currentModel,
            toolChoice: iter.closingTurn ? { type: 'none' } : undefined,
            isNonInteractiveSession:
              toolUseContext.options.isNonInteractiveSession,
            fallbackModel: backups.next(iter.currentModel),
            onStreamingFallback: () => {
              streamingFallbackOccured = true
            },
            onWait: wait => toolUseContext.setSDKStatus?.({ wait }),
            onStreamActivity: atMs => toolUseContext.setSDKStatus?.({ streamActivity: atMs }),
            querySource: run.querySource,
            agents: toolUseContext.options.agentDefinitions.activeAgents,
            allowedAgentTypes:
              toolUseContext.options.agentDefinitions.allowedAgentTypes,
            hasAppendSystemPrompt: !!toolUseContext.options.appendSystemPrompt,
            maxOutputTokensOverride: iter.maxOutputTokensOverride,
            mcpTools: iter.appState.mcp.tools,
            hasPendingMcpServers: iter.appState.mcp.clients.some(
              c => c.type === 'pending',
            ),
            callReference,
            callChain,
            effortValue,
            skipCacheWrite: run.skipCacheWrite,
            agentId: toolUseContext.agentId,
            ownerKey: String(rosterOwnerFromToolUseContext(toolUseContext)),
            addNotification: toolUseContext.addNotification,
          },
        })) {
          if (streamingFallbackOccured) {
            streamingFallbackOccured = false
            for (const msg of iter.assistantMessages) {
              if (msg.inReplyTo !== undefined) iter.replyTo.unshift(...msg.inReplyTo)
              yield emit({ kind: 'assistant_retracted', message: msg })
            }

            iter.needsFollowUp = resetForRetry(iter).needsFollowUp
            chantWatch = new StreamChantWatch()
          }
          if (message.type === 'stream_event' && iter.streamChant === undefined) {
            const detection = chantWatch.feed(message.event)
            if (detection !== null) {
              iter.streamChant = detection
              streamController.abort('stream-chant')
            }
          }
          const yieldMessage: typeof message = backfillCloneForYield(
            message,
            name => findToolByName(toolUseContext.options.tools, name),
          )
          if (message.type === 'assistant') {
            projectedReplies.set(message.uuid, yieldMessage as AssistantMessage)
            settleGauge(message)
            const busyRecovery = message.busyRecovery
            if (busyRecovery !== undefined && !busyRecoveriesReceipted.has(message.uuid)) {
              busyRecoveriesReceipted.add(message.uuid)
              yield emit({
                kind: 'notice',
                message: createBusyRecoveryMessage({
                  provider: busyRecovery.provider,
                  retries: busyRecovery.retries,
                  elapsedMs: busyRecovery.elapsedMs,
                  content: busyRecovery.detail,
                  ...(busyRecovery.status !== undefined ? { status: busyRecovery.status } : {}),
                  ...(busyRecovery.code !== undefined ? { code: busyRecovery.code } : {}),
                }),
              })
            }
            stampReply(message, iter.replyTo)
            if (yieldMessage !== message && message.inReplyTo !== undefined) (yieldMessage as AssistantMessage).inReplyTo = message.inReplyTo
            yield emit({
              kind: 'assistant_settled',
              callId,
              message: yieldMessage,
              withheld:
                iter.streamChant !== undefined ||
                isWithheldMaxOutputTokens(message) ||
                (overflowSignalOf(message) !== null && overflowLadderArmed(run.querySource)),
            })
            iter.assistantMessages.push(message)
            if (!responsesClassified.has(message.message.id)) {
              rememberClassifiedResponse(message.message.id)
              const drops = inputTransformationsOf(message.message)
              const prefixVerdict = takePrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))
              fixedPrefix = prefixVerdict?.fixedPrefix
              if (drops.length > 0) recordDroppedThinking(String(rosterOwnerFromToolUseContext(toolUseContext)), drops)
              const rewrite = prefixVerdict?.mismatch ?? null
              const outcome = classifyThinkingDrops(
                String(ownerFromToolUseContext(toolUseContext)),
                drops,
                prefixMarkOf(
                  iter.messagesForQuery,
                  iter.currentModel,
                  { permissionMode: toolUseContext.getAppState().toolPermissionContext.mode },
                  { requestPlan: iter.requestPlan },
                ),
                { byteMoved: rewrite !== null },
              )
              if (rewrite !== null && outcome.kind !== 'none' && outcome.lawful === null) outcome.part = rewrite.part
              const recordBehind = prefixVerdict?.behind ?? 0
              if (recordBehind > 0 && outcome.kind !== 'none' && outcome.lawful === null) outcome.behind = recordBehind
              const dropNotice = describeThinkingDrops(drops, outcome, turnOrdinalOfWirePath(outcome.path, prefixVerdict?.wireMessageIds ?? [], iter.messagesForQuery))
              if (outcome.kind !== 'none') {
                recordThinkingDropLedger(outcome, iter.currentModel, dropNotice)
                logForDebugging(`preserved thinking: ${JSON.stringify(drops)}`, { level: 'warn' })
              }
              if (dropNotice !== null) {
                const lawful = outcome.kind === 'lawful'
                logForDebugging(`preserved thinking: ${lawful ? 'note' : 'warning'}: ${dropNotice}`)
                yield emit({ kind: 'notice', message: createThinkingNoteMessage(dropNotice, lawful ? 'info' : 'warning') })
              } else if (rewrite !== null && outcome.kind === 'none') {
                const rewriteNotice = describePrefixRewrite(rewrite.part, rewrite.path)
                recordPrefixRewriteLedger(rewrite.part, rewrite.path, iter.currentModel, rewriteNotice)
                if (takeRewriteNoticeOnce(String(ownerFromToolUseContext(toolUseContext)))) {
                  yield emit({ kind: 'notice', message: createThinkingNoteMessage(rewriteNotice, 'warning') })
                }
              }
              const dead = deadMarksFromDrops(drops, prefixVerdict?.wireMessageIds ?? [], deadThinkingMarks(iter.messagesForQuery))
              if (dead.length > 0) {
                logForDebugging(`preserved thinking: ${dead.length} dropped block(s) marked dead on the record (${dead.map(mark => `${mark.messageId}#${mark.blockIndex}`).join(', ')})`)
                const record = createDeadThinkingAttachment(dead)
                yield emit({ kind: 'attachment', message: record })
                iter.deadThinkingRecords.push(record)
              }
            }
            if (toolUseContext.rosterOwner === undefined) {
              const boundRecord = await boundPrefixRecordToEmit(
                String(rosterOwnerFromToolUseContext(toolUseContext)),
                iter.messagesForQuery,
                iter.currentModel,
                toolUseContext.agentId != null
                  ? { rosterOnly: true, context: { userContext: run.userContext, systemContext: run.params.systemContext } }
                  : { rosterOnly: false },
              )
              if (boundRecord !== null) yield emit({ kind: 'attachment', message: boundRecord })
            }

            const msgToolUseBlocks = message.message.content.filter(
              content => content.type === 'tool_use',
            ) as ToolUseBlock[]
            if (msgToolUseBlocks.length > 0) {
              iter.toolUseBlocks.push(...msgToolUseBlocks)
              if (!iter.closingTurn) for (const block of msgToolUseBlocks) iter.early.offer(block, message, iter.toolUseBlocks.indexOf(block))
              iter.needsFollowUp = true
            }
          } else {
            if (iter.streamChant === undefined || message.type !== 'stream_event') yield emit({ kind: 'stream_delta', callId, raw: yieldMessage })
          }
        }
        for (const settled of iter.assistantMessages) {
          settleGauge(settled)
          if (settled.streamEnd === undefined || streamEndsReceipted.has(settled.uuid)) continue
          streamEndsReceipted.add(settled.uuid)
          yield emit({
            kind: 'notice',
            message: createSystemMessage(streamEndReceiptLine(settled.streamEnd), 'warning'),
          })
        }
        for (const settled of iter.assistantMessages) {
          const adjusted = settled.effortAdjusted
          if (adjusted === undefined) continue
          const key = `${toolUseContext.agentId ?? 'main'}:${adjusted.model}:${adjusted.asked}>${adjusted.sent ?? ''}`
          if (effortAdjustmentsReceipted.has(key)) continue
          effortAdjustmentsReceipted.add(key)
          yield emit({
            kind: 'notice',
            message: createSystemMessage(effortAdjustedReceiptLine(adjusted), 'warning'),
          })
        }
        {
          const owner = String(rosterOwnerFromToolUseContext(toolUseContext))
          const leftOut = takeImagesLeftOutReceipt(owner)
          if (leftOut !== null && !imagesLeftOutMarked(iter.messagesForQuery)) {
            yield emit({ kind: 'notice', message: createSystemMessage(imagesLeftOutNoticeLine(leftOut), 'warning') })
            yield emit({ kind: 'attachment', message: createAttachmentMessage({ type: 'images_left_out', count: leftOut.count, images: leftOut.images, sidePx: leftOut.sidePx }) })
          }
        }
      } catch (innerError) {
        if (innerError instanceof FallbackTriggeredError && backups.take(innerError.fallbackModel)) {
          iter.currentModel = innerError.fallbackModel
          attemptWithFallback = true

          yield* emitSyntheticSettlements(
            iter.assistantMessages,
            'Model fallback triggered',
            'error',
            emit,
          )
          iter.needsFollowUp = resetForRetry(iter).needsFollowUp

          toolUseContext.options.engineModel = innerError.fallbackModel


          yield emit({
            kind: 'notice',
            message: createSystemMessage(backupEngineNoticeLine(innerError), 'warning'),
          })

          continue
        }
        throw innerError
      } finally {
        parentSignal.removeEventListener('abort', onAbort)
        releaseModelPermitByCall(permitKey)
      }
    }
  } catch (error) {
    iter.early.reset()
    logError(error)
    const errorMessage =
      describeInvalidArgTypeError(error) ??
      (error instanceof Error ? error.message : String(error))

    if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: error.message,
        }),
      })
      return { kind: 'terminal', terminal: { reason: 'image_error' } }
    }

    yield* emitSyntheticSettlements(
      iter.assistantMessages,
      errorMessage,
      'error',
      emit,
    )

    yield emit({
      kind: 'notice',
      message: createAssistantAPIErrorMessage({
        content: errorMessage,
      }),
    })

    return { kind: 'terminal', terminal: { reason: 'model_error', error } }
  }

  return { kind: 'streamed' }
}


export async function* runEventCore(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<RunEvent, Terminal> {
  return yield* memorySignalScope(runEventMachine(params, consumedCommandUuids))
}

async function* runEventMachine(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<RunEvent, Terminal> {
  const emit = createEventMint()
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  let state: TurnState = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    streamFaultRecoveryCount: 0,
    toolCallRefusalRecoveryCount: 0,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
    overflowEpisode: FRESH_OVERFLOW_EPISODE,
    pendingOverflow: undefined,
  }

  const budgetGuard = new BudgetGuard()

  const config = buildQueryConfig()

  const run: RunCtx = {
    params,
    userContext,
    fallbackModel,
    querySource,
    skipCacheWrite,
    deps,
    config,
    budgetGuard,
  }

  yield emit({
    kind: 'run_started',
    querySource,
    agentId: params.toolUseContext.agentId,
  })

  let iterationOrdinal = 0

  let checkpointSettleWarned = false
  const awaitingReply: ReplyMark[] = []
  const pendingMemoryWrites: RefusedToolCall[] = []
  const holdMemoryWriteRefusals = (refusals: readonly RefusedToolCall[]): void => {
    for (const refusal of memoryWriteRefusals(refusals)) {
      if (!pendingMemoryWrites.some(held => held.id === refusal.id && held.argumentsRaw === refusal.argumentsRaw)) pendingMemoryWrites.push(refusal)
    }
  }
  const memoryWriteLostEvent = (): RunEvent | null => {
    if (pendingMemoryWrites.length === 0) return null
    const line = memoryWriteLostNotice(pendingMemoryWrites)
    pendingMemoryWrites.length = 0
    return emit({ kind: 'notice', message: createSystemMessage(line, 'error') })
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      maxOutputTokensOverride,
      streamFaultRecoveryCount,
      toolCallRefusalRecoveryCount,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
      pendingOverflow,
    } = state
    let overflowEpisode = state.overflowEpisode
    const closingTurn = maxTurns !== undefined && budgetGuard.maxTurnsExceeded(turnCount, maxTurns)

    const ordinal = ++iterationOrdinal
    const turnId = `t${ordinal}`
    yield emit({ kind: 'turn_started', turnId, n: ordinal })

    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    const callChain = advanceToolCallChain(toolUseContext, () => deps.uuid())

    const chainIdForAnalytics =
      callChain.key

    toolUseContext = {
      ...toolUseContext,
      callChain,
    }

    let tracking = autoCompactTracking

    const persistReplacements =
      querySource === 'sdk' ||
      querySource.startsWith('agent:') ||
      querySource.startsWith('main_thread')
    const preserveBodies = pendingOverflow?.rung !== 'prune'
    const requestPlan = await buildRequestContextPlan(
      {
        messages,
        owner: ownerFromToolUseContext(toolUseContext),
        querySource,
        engineModel: toolUseContext.options.engineModel,
        contentReplacementState: toolUseContext.contentReplacementState,
        persistReplacements: persistReplacements
          ? async records => {
              await recordContentReplacement(records, toolUseContext.agentId)
              await flushSessionStorage()
            }
          : undefined,
        skipToolNames: new Set(
          toolUseContext.options.tools
            .filter(t => !Number.isFinite(t.maxResultSizeChars))
            .map(t => t.name),
        ),
        microcompact: deps.microcompact,
        preserveBodies,
        readFileState: toolUseContext.readFileState,
        calibrationKey: (() => {
          const model = toolUseContext.options.engineModel
          return typeof model === 'string' && model
            ? calibrationKeyFor(declaredRouteOf(model) ?? 'unrecognised', model)
            : null
        })(),
        fixedRequest: requestGaugeFixed({
          system: appendSystemContext(systemPrompt, systemContext),
          userContext: latestUserContextBody(messages) === null ? userContext : null,
          tools: await Promise.all(toolsOnTheWire(await planToolPayloadUnseeded({
            model: toolUseContext.options.engineModel,
            tools: toolUseContext.options.tools,
            messages,
            getToolPermissionContext: async () => toolUseContext.getAppState().toolPermissionContext,
            agents: toolUseContext.options.agentDefinitions.activeAgents,
            hasPendingMcpServers: toolUseContext.getAppState().mcp.clients.some(c => c.type === 'pending'),
            latchKey: String(rosterOwnerFromToolUseContext(toolUseContext)),
            source: 'gauge',
          })).map(tool => toolToAPISchema(tool, {
            getToolPermissionContext: async () => toolUseContext.getAppState().toolPermissionContext,
            tools: toolUseContext.options.tools,
            agents: toolUseContext.options.agentDefinitions.activeAgents,
            allowedAgentTypes: toolUseContext.options.agentDefinitions.allowedAgentTypes,
            model: toolUseContext.options.engineModel,
          }).catch(() => ({ name: tool.name })))),
        }),
        harnessContextPolicy: null,
        ...(pendingOverflow?.rung === 'prune' ? { pressurePrune: true as const } : {}),
      },
      'apply',
    )
    let messagesForQuery = requestPlan.messages
    const prunedTokensFreed = requestPlan.gauge === undefined ? Math.max(0, requestPlan.reductions.pressurePruned?.tokensSaved ?? 0) : 0
    const clearedByDigest = (requestPlan.reductions.pressurePruned?.cleared ?? 0) + requestPlan.reductions.timeBasedCleared
    if (clearedByDigest > 0) {
      const digested = await fireHooks(
        'compaction.after',
        { method: 'digest', trigger: pendingOverflow?.rung === 'prune' ? 'overflow' : 'auto', tokens_before: estimateContextTokens(messages), tokens_after: estimateContextTokens(messagesForQuery) },
        { scope: { sessionId: String(getSessionId()), ...(toolUseContext.agentId !== undefined ? { crewmateId: toolUseContext.agentId } : {}) }, signal: toolUseContext.abortController.signal, toolUseContext },
      )
      for (const row of hookRowsOfResult(digested)) yield emit({ kind: 'attachment', message: createAttachmentMessage(row) })
      if (digested.answer.contexts.length > 0) {
        messagesForQuery = [...messagesForQuery, ...digested.answer.contexts.map(words => createUserMessage({ content: words, isMeta: true }))]
      }
    }
    const deadThinkingRecords: AttachmentMessage[] = []
    {
      const known = deadThinkingMarks(messages)
      const fresh = (requestPlan.reductions.deadThinkingMarks ?? []).filter(mark => !known.get(mark.messageId)?.has(mark.blockIndex))
      if (fresh.length > 0) {
        const record = createDeadThinkingAttachment(fresh)
        yield emit({ kind: 'attachment', message: record })
        deadThinkingRecords.push(record)
      }
    }
    if (pendingOverflow?.rung === 'prune') {
      const pruned = requestPlan.reductions.pressurePruned
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          overflowRecoveryNotice(pendingOverflow.signal, 'prune', pruned ?? { cleared: 0, tokensSaved: 0 }),
          'warning',
        ),
      })
    }

    if (messagesForQuery.length < requestPlan.afterBoundaryCount) {
      emitCompactionTrace('microcompact', {
        messagesBefore: requestPlan.afterBoundaryCount,
        messagesAfter: messagesForQuery.length,
      })
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    const forcedFold = pendingOverflow?.rung === 'fold' ? pendingOverflow.signal : undefined
    const foldSplit = splitCarriedOperatorTail(messagesForQuery)
    const {
      compactionResult,
      consecutiveFailures,
      consecutiveRapidRefills,
      rapidRefillBreakerTripped,
      measuredRawTokenCount,
      refusal: compactionRefusal,
      paused: compactionPaused,
    } = pendingOverflow?.rung === 'prune' ? { wasCompacted: false } as Awaited<ReturnType<typeof deps.autocompact>> : await deps.autocompact(
      foldSplit.head,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: foldSplit.head,
        postFoldCarry: foldSplit.carry,
      },
      querySource,
      tracking,
      prunedTokensFreed,
      forcedFold,
    )

    if (rapidRefillBreakerTripped) {
      yield emit({
        kind: 'notice',
        message: createSystemMessage(
          `${AUTOCOMPACT_THRASH_MESSAGE} ${rapidRefillPauseText({ nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession) })}`,
          'warning',
        ),
      })
    }
    const rapidRefillPaused = tracking?.rapidRefillPaused === true || rapidRefillBreakerTripped === true

    if (forcedFold !== undefined && !compactionResult) {
      if (!toolUseContext.abortController.signal.aborted && (forcedFold.source === 'provider' || (compactionRefusal !== undefined && compactionRefusal !== ERROR_MESSAGE_USER_ABORT))) {
        const saving = projectTimeBasedMicrocompact(messagesForQuery, querySource, { pressure: true, supersededOnly: true })?.tokensSaved ?? 0
        const fallback = decideOverflowRecovery({ episode: overflowEpisode, gapTokens: overflowGapFor(forcedFold), pruneSavingTokens: saving, pruneAllowed: true, fold: { available: false, why: 'fold-failed' } })
        if (fallback.kind === 'recover' && fallback.rung === 'prune') {
          const next: TurnState = {
            ...state, messages: messagesForQuery, toolUseContext, autoCompactTracking: tracking,
            overflowEpisode: { folded: true, pruned: true },
            pendingOverflow: { signal: forcedFold, rung: 'prune' },
            transition: { reason: 'overflow_recovery', rung: 'prune', source: forcedFold.source },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
      }
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: overflowRefusalText(forcedFold, 'fold-failed', {
            nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession),
            ...(compactionRefusal !== undefined ? { detail: compactionRefusal } : {}),
          }),
          error: 'invalid_request',
          ...(forcedFold.detail !== undefined ? { errorDetails: forcedFold.detail } : {}),
          overflow: forcedFold,
        }),
      })
      const terminal: Terminal =
        forcedFold.source === 'estimate' ? { reason: 'blocking_limit' } : { reason: 'prompt_too_long' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (forcedFold === undefined && compactionPaused === true && compactionRefusal !== undefined) {
      yield emit({ kind: 'notice', message: createSystemMessage(compactionRefusal, 'warning') })
    }

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
      } = compactionResult

      const postForTrace = truePostCompactTokenCount ?? postCompactTokenCount
      emitCompactionTrace('auto-compact', {
        tokensFreed:
          typeof preCompactTokenCount === 'number' &&
          typeof postForTrace === 'number'
            ? preCompactTokenCount - postForTrace
            : undefined,
      })

      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
        consecutiveRapidRefills,
        ...(rapidRefillPaused ? { rapidRefillPaused: true as const } : {}),
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      const carried = foldSplit.carry.map(row => ({ ...row, uuid: randomUUID() as UUID }))
      yield emit({
        kind: 'compaction_boundary',
        trigger: forcedFold !== undefined ? 'overflow' : 'auto',
        messages: [...postCompactMessages, ...carried],
      })
      resetSessionEnvNoticeOnCompaction()

      messagesForQuery = [...postCompactMessages, ...carried]
      overflowEpisode = { pruned: overflowEpisode.pruned, folded: true }
    } else if (consecutiveFailures !== undefined || rapidRefillPaused) {
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
        ...(rapidRefillPaused ? { rapidRefillPaused: true as const } : {}),
      }
    }

    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const appState = toolUseContext.getAppState()
    const currentModel = toolUseContext.options.engineModel
    const justCompactedUnderLimit =
      compactionResult !== undefined &&
      (compactionResult.truePostCompactTokenCount === undefined ||
        calculateTokenWarningState(
          compactionResult.truePostCompactTokenCount,
          toolUseContext.options.engineModel,
        ).level !== 'blocked')
    if (
      !justCompactedUnderLimit &&
      querySource !== 'compact' &&
      querySource !== 'session_memory'
    ) {
      const estimatedTokens =
        compactionResult?.truePostCompactTokenCount ??
        Math.max(
          0,
          (measuredRawTokenCount ?? tokenCountWithEstimation(messagesForQuery, toolUseContext.options.engineModel)) -
            prunedTokensFreed,
        )
      const { level } = calculateTokenWarningState(
        estimatedTokens,
        toolUseContext.options.engineModel,
      )
      const localFits = level === 'blocked' && localPromptFits(currentModel, { messages: messagesForQuery, systemPrompt: fullSystemPrompt, tools: toolUseContext.options.tools })
      if (localFits) logForDebugging(`blocking preempt: the composed request fits ${currentModel}'s planned window — sent`)
      if (level === 'blocked' && !localFits) {
        const localUnfit = localPromptFitRefusal(currentModel, { messages: messagesForQuery, systemPrompt: fullSystemPrompt, tools: toolUseContext.options.tools })
        if (localUnfit !== undefined) {
          yield emit({
            kind: 'notice',
            message: createAssistantAPIErrorMessage({
              content: `${API_ERROR_MESSAGE_PREFIX}: ${localUnfit}`,
              error: 'invalid_request',
            }),
          })
          const terminal: Terminal = { reason: 'blocking_limit' }
          yield emit({ kind: 'run_terminal', terminal })
          return terminal
        }
        if (overflowLadderArmed(querySource)) {
          const blockingLimit = getBlockingLimit(toolUseContext.options.engineModel)
          const signal = estimateOverflowSignal({
            family: declaredRouteOf(currentModel) ?? 'unknown',
            actualTokens: estimatedTokens,
            limitTokens: blockingLimit,
          })
          const pruneSaving =
            projectTimeBasedMicrocompact(messagesForQuery, querySource, { pressure: true, supersededOnly: true })?.tokensSaved ?? 0
          const headFoldFailed =
            (consecutiveFailures ?? 0) > (autoCompactTracking?.consecutiveFailures ?? 0)
          const decision = decideOverflowRecovery({
            episode: overflowEpisode,
            gapTokens: Math.max(1, estimatedTokens - blockingLimit),
            pruneSavingTokens: pruneSaving,
            pruneAllowed: compactionRefusal !== undefined && compactionRefusal !== ERROR_MESSAGE_USER_ABORT,
            fold: foldAvailability({
              tracking,
              headFold: !foldSplit.hasHistory ? undefined : headFoldFailed ? 'failed' : isAutoCompactEnabled() ? 'did-not-land' : undefined,
              ...(headFoldFailed && compactionRefusal !== undefined ? { headFoldDetail: compactionRefusal } : {}),
              hasHistory: foldSplit.hasHistory,
            }),
          })
          if (decision.kind === 'recover') {
            if (decision.rung === 'fold') {
              yield emit({ kind: 'notice', message: createSystemMessage(overflowRecoveryNotice(signal, 'fold'), 'warning') })
            }
            const next: TurnState = {
              messages: messagesForQuery,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              lastOutputLimitReply: state.lastOutputLimitReply,
              maxOutputTokensOverride,
              streamFaultRecoveryCount,
              toolCallRefusalRecoveryCount,
              pendingToolUseSummary,
              stopHookActive,
              turnCount,
              overflowEpisode: {
                pruned: overflowEpisode.pruned || decision.rung === 'prune',
                folded: overflowEpisode.folded || decision.rung === 'fold',
              },
              pendingOverflow: { signal, rung: decision.rung },
              transition: { reason: 'overflow_recovery', rung: decision.rung, source: 'estimate' },
            }
            yield emit({ kind: 'turn_settled', transition: next.transition! })
            state = next
            continue
          }
          const why = decision.kind === 'refuse' ? decision.why : 'fold-failed'
          yield emit({
            kind: 'notice',
            message: createAssistantAPIErrorMessage({
              content: overflowRefusalText(signal, why, {
                nonInteractive: foldRemedyIsHeadless(toolUseContext.options.isNonInteractiveSession),
                ...(decision.kind === 'refuse' && decision.detail !== undefined ? { detail: decision.detail } : {}),
              }),
              error: 'invalid_request',
              overflow: signal,
            }),
          })
          const terminal: Terminal = why === 'breaker' && tracking?.rapidRefillPaused === true ? { reason: 'rapid_refill_breaker' } : { reason: 'blocking_limit' }
          yield emit({ kind: 'run_terminal', terminal })
          return terminal
        }
        yield emit({
          kind: 'notice',
          message: createAssistantAPIErrorMessage({
            content: PROMPT_TOO_LONG_ERROR_MESSAGE,
            error: 'invalid_request',
          }),
        })
        const terminal: Terminal = { reason: 'blocking_limit' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }
    }

    const iter: IterationState = {
      turnId,
      ordinal,
      requestPlan,
      messagesForQuery,
      toolUseContext,
      callChain,
      chainIdForAnalytics,
      tracking,
      fullSystemPrompt,
      appState,
      currentModel,
      maxOutputTokensOverride,
      assistantMessages: [],
      toolResults: [],
      deadThinkingRecords,
      toolUseBlocks: [],
      needsFollowUp: false,
      closingTurn,
      callOrdinal: 0,
      replyTo: awaitingReply,
      early: new EarlyStarts(toolUseContext, canUseTool),
    }

    const streamOutcome = yield* streamModel(run, iter, emit)
    if (streamOutcome.kind === 'terminal') {
      yield emit({ kind: 'run_terminal', terminal: streamOutcome.terminal })
      return streamOutcome.terminal
    }
    if (deadThinkingRecords.length > 0) messagesForQuery = [...messagesForQuery, ...deadThinkingRecords]
    if (iter.streamChant !== undefined && !toolUseContext.abortController.signal.aborted) yield* trimChantedIteration(iter, iter.streamChant, emit)
    const { assistantMessages, toolResults, toolUseBlocks } = iter
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
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield emit({ kind: 'notice', message: summary })
      }
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
        const next: TurnState = {
          ...state,
          messages: messagesForQuery,
          autoCompactTracking: tracking,
          maxOutputTokensOverride: decision.outputTokens,
          cutToolCallRecoveryCount: cutToolCallRecoveryCount + 1,
          pendingToolUseSummary: undefined,
          stopHookActive: undefined,
          turnCount,
          pendingOverflow: undefined,
          transition: { reason: 'cut_tool_call_recovery', attempt: decision.attempt, outputTokens: decision.outputTokens },
        }
        yield emit({ kind: 'turn_settled', transition: next.transition! })
        state = next
        continue
      }
    }

    if (!iter.needsFollowUp) {
      iter.early.reset()
      const lastMessage = assistantMessages.at(-1)

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
          const next: TurnState = {
            messages: foldInput,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode: {
              pruned: overflowEpisode.pruned || decision.rung === 'prune',
              folded: overflowEpisode.folded || decision.rung === 'fold',
            },
            pendingOverflow: { signal: overflow, rung: decision.rung },
            transition: { reason: 'overflow_recovery', rung: decision.rung, source: overflow.source },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
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
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      const paused = pausedReplyOf(assistantMessages)
      if (paused !== null) {
        const pauseTurnContinuations = state.pauseTurnContinuations ?? 0
        const decision = decidePauseTurnContinuation({ continuations: pauseTurnContinuations })
        if (decision.kind === 'continue') {
          const nextTurnCount = turnCount + 1
          if (maxTurns !== undefined && budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)) {
            yield emit({ kind: 'attachment', message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount }) })
            const terminal: Terminal = { reason: 'max_turns', turnCount: nextTurnCount }
            yield emit({ kind: 'run_terminal', terminal })
            return terminal
          }
          yield emit({
            kind: 'notice',
            message: createSystemMessage(`the provider paused the turn mid-work — sending it back to continue (${decision.attempt} of ${PAUSE_TURN_CONTINUATION_LIMIT}); it counts as a turn`, 'suggestion'),
          })
          const next: TurnState = {
            ...state,
            messages: [...messagesForQuery, ...assistantMessages.filter(m => m.isApiErrorMessage !== true)],
            autoCompactTracking: tracking,
            turnCount: nextTurnCount,
            pauseTurnContinuations: pauseTurnContinuations + 1,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            pendingOverflow: undefined,
            transition: { reason: 'pause_turn_continuation', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
        yield emit({
          kind: 'notice',
          message: createSystemMessage(`the provider paused the turn ${pauseTurnContinuations} times in a row; the reply stands as it is and the turn ends here`, 'warning'),
        })
      }

      const chant = iter.streamChant ?? (lastMessage !== undefined && (lastMessage.isApiErrorMessage !== true || isWithheldMaxOutputTokens(lastMessage)) ? detectChant(replyTextOf(assistantMessages)) : null)

      const reasoningOnly = chant === null ? reasoningOnlyTurnOf(assistantMessages, refusedToolCalls.length) : null
      if (reasoningOnly !== null) {
        const reasoningOnlyRecoveryCount = state.reasoningOnlyRecoveryCount ?? 0
        const decision = decideReasoningOnlyRecovery({ recoveryCount: reasoningOnlyRecoveryCount, maxTokens: reasoningOnly.maxTokens })
        const outputLimit = reasoningOnly.maxTokens
          ? outputLimitWords(maxOutputTokensOverride ?? getModelMaxOutputTokens(iter.currentModel).default)
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
          const next: TurnState = {
            messages: [...messagesForQuery, ...carried, nudge],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            emptyReplyRecoveryCount: state.emptyReplyRecoveryCount,
            chantRecoveryCount: state.chantRecoveryCount,
            reasoningOnlyRecoveryCount: reasoningOnlyRecoveryCount + 1,
            transition: { reason: 'reasoning_only_recovery', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
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

          const next: TurnState = {
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
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: decision.attempt,
            },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }

        yield emit({
          kind: 'notice',
          message: createSystemMessage(OUTPUT_LIMIT_STOP_WORDS[decision.why], 'warning'),
        })
        yield emit({ kind: 'withheld_surfaced', message: lastMessage })
      }

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
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages.filter(m => m.isApiErrorMessage !== true), recoveryMessage],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount: streamFaultRecoveryCount + 1,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'stream_fault_recovery', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
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

      if (lastMessage && emptyReplyKindOf(lastMessage) === 'silence') {
        const silence = emptyReplyNoteOf(lastMessage) ?? 'the provider finished this response with nothing said; the turn ends here, not cut.'
        yield emit({ kind: 'notice', message: createSystemMessage(silence, 'info') })
      }

      if (lastMessage && emptyReplyKindOf(lastMessage) === 'empty') {
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
          const next: TurnState = {
            messages: endsWithEmptyReplyRecoveryNudge(messagesForQuery) ? messagesForQuery : [...messagesForQuery, nudge],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            emptyReplyRecoveryCount: emptyReplyRecoveryCount + 1,
            transition: { reason: 'empty_reply_retry', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
        yield emit({
          kind: 'notice',
          message: createSystemMessage(emptyReplyEndedLine(emptyReplyRecoveryCount), 'warning'),
        })
      }

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
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, correction],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount: toolCallRefusalRecoveryCount + 1,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'tool_call_refusal_recovery', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
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
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

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
          const next: TurnState = {
            messages: [...messagesForQuery, ...replyMessages, nudge],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            lastOutputLimitReply: state.lastOutputLimitReply,
            maxOutputTokensOverride,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            emptyReplyRecoveryCount: state.emptyReplyRecoveryCount,
            chantRecoveryCount: chantRecoveryCount + 1,
            transition: { reason: 'chant_recovery', attempt: decision.attempt },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
        if (isLoopGuardStopEnabled()) {
          yield emit({
            kind: 'notice',
            message: createSystemMessage(
              chantNoticeLine(chant, `the reply repeated itself again after the loop notice; the turn is ended (${LOOP_GUARD_STOP_SETTING})`),
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
          yield emit({ kind: 'run_terminal', terminal })
          return terminal
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

      if (closingTurn && maxTurns !== undefined) {
        yield emit({
          kind: 'attachment',
          message: createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount }),
        })
        const lostAtCap = memoryWriteLostEvent()
        if (lostAtCap !== null) yield lostAtCap
        const terminal: Terminal = { reason: 'max_turns', turnCount }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      if (lastMessage?.isApiErrorMessage) {
        const sizeWarning = requestSizeWarning(messagesForQuery, iter.currentModel)
        if (sizeWarning !== null) {
          yield emit({ kind: 'notice', message: createSystemMessage(sizeWarning, 'warning') })
        }
        const lostOnError = memoryWriteLostEvent()
        if (lostOnError !== null) yield lostOnError
        const terminal: Terminal = { reason: 'completed' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

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
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: TurnState = {
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
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          overflowEpisode,
          pendingOverflow: undefined,
          transition: { reason: 'stop_hook_blocking' },
        }
        yield emit({ kind: 'turn_settled', transition: next.transition! })
        state = next
        continue
      }

      if (!checkpointSettleWarned) {
        const liveCheckpoint = findActiveCheckpoint([
          ...messagesForQuery,
          ...assistantMessages,
        ])
        if (liveCheckpoint !== null) {
          checkpointSettleWarned = true
          const warning = createSettleGuardWarning(liveCheckpoint)
          yield emit({ kind: 'attachment', message: warning })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, warning],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'checkpoint_settle_guard' },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
      }

      if (toolUseContext.agentId) {
        const queued = getAgentPendingMessageAttachments(toolUseContext).map(attachment => createAttachmentMessage(attachment))
        if (queued.length > 0) {
          for (const row of queued) yield emit({ kind: 'attachment', message: row })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, ...queued],
            toolUseContext,
            autoCompactTracking: tracking,
            turnCount: turnCount + 1,
            maxOutputTokensRecoveryCount: 0,
            streamFaultRecoveryCount: 0,
            toolCallRefusalRecoveryCount: 0,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            overflowEpisode: FRESH_OVERFLOW_EPISODE,
            pendingOverflow: undefined,
            transition: { reason: 'queued_message', count: queued.length },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }
      }

      await finishMemorySignal(assistantText(assistantMessages))
      if (handoffAskDue({ agentId: toolUseContext.agentId, querySource })) {
        let closeUsage: import('../services/api/emptyUsage.js').NonNullableUsage | undefined
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
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

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
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
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

    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId
    ) {
      const lastTextBlock = assistantMessages.at(-1)?.message.content.findLast(
        block => block.type === 'text',
      )
      const lastAssistantText = lastTextBlock && 'text' in lastTextBlock
        ? lastTextBlock.text
        : undefined

      const firstResultByCall = new Map<string, ToolResultBlockParam>()
      for (const result of toolResults) {
        if (result.type !== 'user' || !Array.isArray(result.message.content)) continue
        for (const content of result.message.content) {
          if (content.type !== 'tool_result' || firstResultByCall.has(content.tool_use_id)) continue
          firstResultByCall.set(content.tool_use_id, content)
        }
      }
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(({ id, name, input }) => {
        const settlement = firstResultByCall.get(id)
        const output = settlement && 'content' in settlement ? settlement.content : null
        return { name, input, output }
      })

      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => summary ? createToolUseSummaryMessage(summary, toolUseIds) : null)
        .catch(() => null)
    }

    if (toolUseContext.abortController.signal.aborted) {
      const cutReason = toolUseContext.abortController.signal.reason
      const steer = cutReason === 'interrupt'
      yield emit({
        kind: 'interruption',
        phase: 'tools',
        steer,
        message: steer ? null : createUserInterruptionMessage({ toolUse: true, reason: cutReason }),
      })
      yield emit({
        kind: 'notice',
        message: createSystemMessage(interruptedToolsLine(toolUseBlocks.map(block => block.name)), 'warning'),
      })
      const nextTurnCountOnAbort = turnCount + 1
      if (
        maxTurns !== undefined &&
        budgetGuard.maxTurnsExceeded(nextTurnCountOnAbort, maxTurns)
      ) {
        yield emit({
          kind: 'attachment',
          message: createAttachmentMessage({
            type: 'max_turns_reached',
            maxTurns,
            turnCount: nextTurnCountOnAbort,
          }),
        })
      }
      const terminal: Terminal = { reason: 'aborted_tools' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (shouldPreventContinuation) {
      const terminal: Terminal = { reason: 'hook_stopped' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }
    if (loopStoppedCycle !== null) {
      if (loopStoppedRecord !== null) yield emit({ kind: 'attachment', message: loopStoppedRecord })
      const terminal: Terminal = { reason: 'loop_stopped', cycle: loopStoppedCycle }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    {
      const rewindRecord = buildRewindRecordIfSettled(
        [...messagesForQuery, ...assistantMessages, ...toolResults],
        toolUseBlocks,
        toolResults,
      )
      if (rewindRecord !== null) {
        yield emit({ kind: 'attachment', message: rewindRecord })
        toolResults.push(rewindRecord)
      }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
    }


    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const currentAgentId = toolUseContext.agentId
    const isMainThread =
      currentAgentId === undefined &&
      (querySource.startsWith('main_thread') || querySource === 'sdk')
    const queuedCommandsSnapshot = selectDrainableCommands(
      getDrainableCommands(sleepRan),
      { sleepRan, isMainThread, agentId: currentAgentId },
      isSlashCommand,
    )
    markDraining(queuedCommandsSnapshot)

    const yieldedCommandUuids = new Set<string>()
    let drainProduced = false
    try {
      for await (const attachment of getAttachmentMessages(
        null,
        updatedToolUseContext,
        queuedCommandsSnapshot,
        [...messagesForQuery, ...assistantMessages, ...toolResults],
        querySource,
      )) {
        const att = attachment.attachment as { type?: string; source_uuid?: string }
        if (att.type === 'queued_command' && typeof att.source_uuid === 'string') {
          yieldedCommandUuids.add(att.source_uuid)
        }
        yield emit({ kind: 'attachment', message: attachment })
        toolResults.push(attachment)
        const mark = replyMarkOf(attachment)
        if (mark !== null) awaitingReply.push(mark)
      }
      drainProduced = true
    } finally {
      markDraining([])
      consumedCommandUuids.push(
        ...consumeDrainedCommands(
          drainProduced
            ? queuedCommandsSnapshot
            : queuedCommandsSnapshot.filter(
                cmd => cmd.uuid !== undefined && yieldedCommandUuids.has(cmd.uuid),
              ),
          {
            notifyStarted: uuid => notifyCommandLifecycle(uuid, 'started'),
            removeFromQueue,
          },
        ),
      )
    }

    for (const cmd of queuedCommandsSnapshot) {
      if (
        (cmd.mode === 'prompt' || cmd.mode === 'task-notification') &&
        cmd.uuid
      ) {
        yield emit({
          kind: 'followup_drained',
          uuid: cmd.uuid,
          source: cmd.mode,
        })
      }
    }


    updatedToolUseContext = refreshTurnTools(updatedToolUseContext)
    const contextForNextTurn = { ...updatedToolUseContext, callChain }

    const nextTurnCount = turnCount + 1

    const closingNext =
      maxTurns !== undefined && budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)
        ? [createUserMessage({ content: MAX_TURNS_CLOSING_TEXT, isMeta: true })]
        : []

    const next: TurnState = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults, ...closingNext],
      toolUseContext: contextForNextTurn,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      streamFaultRecoveryCount: 0,
      toolCallRefusalRecoveryCount: 0,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
      overflowEpisode: FRESH_OVERFLOW_EPISODE,
      pendingOverflow: undefined,
    }
    yield emit({ kind: 'turn_settled', transition: next.transition! })
    state = next
  }
}
