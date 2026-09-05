import type { ToolResultBlockParam, ToolUseBlock } from '../types/wire.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import {
  AUTOCOMPACT_THRASH_MESSAGE,
  calculateTokenWarningState,
  getBlockingLimit,
  type AutoCompactTrackingState,
} from '../services/compact/autoCompact.js'
import { buildPostCompactMessages } from '../services/compact/compact.js'
import { projectTimeBasedMicrocompact } from '../services/compact/microCompact.js'
import {
  classifyThinkingDrops,
  deadMarksFromDrops,
  deadThinkingMarks,
  describePrefixRewrite,
  describeThinkingDrops,
  inputTransformationsOf,
  modelSwitchReceipt,
  prefixMarkOf,
  recordPrefixRewriteLedger,
  recordThinkingDropLedger,
} from '../services/providers/anthropic/thinkingBinding.js'
import { takePrefixVerdict } from '../services/providers/anthropic/prefixLedger.js'
import { boundPrefixRecordToEmit } from '../services/providers/anthropic/boundPrefixRecord.js'
import { logForDebugging } from '../utils/debug.js'

const switchReceipts = new Set<string>()

const responsesClassified = new Set<string>()
const streamEndsReceipted = new Set<string>()
const effortAdjustmentsReceipted = new Set<string>()
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
  foldAvailability,
  overflowGapFor,
  overflowLadderArmed,
  overflowRecoveryNotice,
  overflowRefusalText,
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
import { ImageResizeError } from '../utils/imageResizer.js'
import { describeInvalidArgTypeError } from '../utils/errors.js'
import { findToolByName, type ToolUseContext } from '../Tool.js'
import {
  applyTurnTierEffort,
  applyTurnTierModel,
} from '../utils/autopilot/tierState.js'
import {
  effortAdjustedReceiptLine,
  isTurnOwningQuerySource,
  resolveEffortTruth,
} from '../utils/effort.js'
import { asSystemPrompt, type SystemPrompt } from '../utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ToolUseSummaryMessage,
  UserMessage,
} from '../types/message.js'
import { logError } from '../utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  STREAM_FAULT_RECOVERY_NUDGE,
  isContinuableStreamFaultMessage,
} from '../services/api/errors.js'
import {
  collectRefusedToolCalls,
  toolCallRefusalCorrection,
} from '../services/providers/toolCallGate.js'
import { logAntError } from '../utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createThinkingDeadMessage,
  createAssistantAPIErrorMessage,
  createToolUseSummaryMessage,
} from '../utils/messages.js'
import { generateToolUseSummary } from '../services/toolUseSummary/toolUseSummaryGenerator.js'
import {
  buildRewindRecordIfSettled,
  createSettleGuardWarning,
  findActiveCheckpoint,
} from '../services/compact/checkpointRewind.js'
import { prependUserContext, appendSystemContext } from '../utils/api.js'
import { latestUserContextBody } from '../utils/attachments/userContext.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from '../utils/attachments.js'
import {
  remove as removeFromQueue,
  getDrainableCommands,
  markDraining,
  isSlashCommand,
} from '../utils/messageQueueManager.js'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from '../utils/headlessProfiler.js'
import {
  getPublicModelDisplayName,
  getRuntimeMainLoopModel,
  renderModelName,
} from '../utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from '../utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from '../utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import {
  BRIEF_TOOL_NAME,
  LEGACY_BRIEF_TOOL_NAME,
} from '../tools/BriefTool/prompt.js'
import { executePostSamplingHooks } from '../utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from '../utils/hooks.js'
import type { QuerySource } from '../constants/querySource.js'
import { createDumpPromptsFetch } from '../services/api/dumpPrompts.js'
import {
  getActivePulseTrace,
  isPulseMainSource,
  notePulseModel,
  pulseMark,
  pulseStageEnd,
  pulseStageStart,
  setPulsePhase,
} from '../utils/pulse/index.js'
import { runTools } from '../services/tools/toolOrchestration.js'
import {
  repetitionStopNotice,
  takeRepetitionStop,
} from '../services/tools/identicalFailureGuard.js'
import { emitCompactionTrace } from '../utils/observability/invocationTrace.js'
import { recordContentReplacement } from '../utils/sessionStorage.js'
import { handleStopHooks } from '../query/stopHooks.js'
import { buildRequestContextPlan, reconcileAppliedPlanUsage } from '../services/run/requestContextPlan.js'
import { calibrationKeyFor } from '../services/run/contextCalibration.js'
import { harnessContextPolicyRequest } from '../services/mission/harnessApplication.js'
import { declaredRouteOf } from '../services/providers/callModelRouter.js'
import { streamEndReceiptLine } from '../services/providers/streamIdleBudget.js'
import { interruptedToolsLine, turnCutOf, turnCutResultText } from '../utils/messages/rejectionText.js'
import { ownerFromToolUseContext, rosterOwnerFromToolUseContext } from '../services/run/resolveOwner.js'
import { evaluateCycleLease, renderHandoffReport } from '../services/run/cycleLease.js'
import { getRunSnapshot, noteRunEvent } from '../services/run/runCoordinator.js'
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
  selectDrainableCommands,
} from './attachment-drain.js'
import { buildModelCallReference } from './call-reference.js'
import { createEventMint, type RunEvent } from './events.js'
import { acquireModelPermit, releaseModelPermitByCall } from '../services/capacity/governor.js'
import { refreshGovernorCeilings } from '../services/capacity/composeCeilings.js'
import { count } from '../utils/array.js'

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

type EventMint = ReturnType<typeof createEventMint>

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  taskBudget?: { total: number }
  deps?: QueryDeps
}


type TurnState = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  maxOutputTokensOverride: number | undefined
  streamFaultRecoveryCount: number
  toolCallRefusalRecoveryCount: number
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
  cycleReplanInjected?: boolean
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
  messagesForQuery: Message[]
  toolUseContext: ToolUseContext
  queryTracking: { chainId: string; depth: number }
  chainIdForAnalytics: string
  tracking: AutoCompactTrackingState | undefined
  fullSystemPrompt: SystemPrompt
  appState: ReturnType<ToolUseContext['getAppState']>
  dumpPromptsFetch: ReturnType<typeof createDumpPromptsFetch> | undefined
  currentModel: string
  maxOutputTokensOverride: number | undefined
  assistantMessages: AssistantMessage[]
  toolResults: (UserMessage | AttachmentMessage)[]
  toolUseBlocks: ToolUseBlock[]
  needsFollowUp: boolean
  callOrdinal: number
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
  | { kind: 'escalate' }
  | { kind: 'nudge'; attempt: number }
  | { kind: 'surface' }

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
  capEnabled: boolean
  envPinned: boolean
  maxOutputTokensOverride: number | undefined
  recoveryCount: number
}): MaxOutputTokensDecision {
  if (
    input.capEnabled &&
    input.maxOutputTokensOverride === undefined &&
    !input.envPinned
  ) {
    return { kind: 'escalate' }
  }
  if (input.recoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    return { kind: 'nudge', attempt: input.recoveryCount + 1 }
  }
  return { kind: 'surface' }
}

function isBriefTerminalTurn(
  querySource: QuerySource,
  toolUseContext: ToolUseContext,
  toolUseBlocks: ToolUseBlock[],
  toolResults: (UserMessage | AttachmentMessage)[],
): boolean {
  return (
    !toolUseContext.agentId &&
    (querySource.startsWith('repl_main_thread') || querySource === 'sdk') &&
    toolUseBlocks.length > 0 &&
    toolUseBlocks.every(
      // eslint-disable-next-line custom-rules/require-tool-match-name -- matches BOTH the canonical name and its legacy alias
      b => b.name === BRIEF_TOOL_NAME || b.name === LEGACY_BRIEF_TOOL_NAME,
    ) &&
    !toolResults.some(
      m =>
        m.type === 'user' &&
        Array.isArray(m.message.content) &&
        m.message.content.some(
          c => c.type === 'tool_result' && c.is_error === true,
        ),
    )
  )
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


type StreamOutcome =
  | { kind: 'streamed' }
  | { kind: 'terminal'; terminal: Terminal }

async function* streamModel(
  run: RunCtx,
  iter: IterationState,
  emit: EventMint,
): AsyncGenerator<RunEvent, StreamOutcome> {
  const { toolUseContext, queryTracking } = iter
  let attemptWithFallback = true

  const pulseMain = isPulseMainSource(run.querySource, toolUseContext.agentId)
  if (pulseMain) pulseMark('api_loop_start')
  try {
    while (attemptWithFallback) {
      attemptWithFallback = false
      const callId = `${iter.turnId}.c${++iter.callOrdinal}`
      const permitKey = `${iter.queryTracking.chainId}:${callId}`
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
      const effortValue = isTurnOwningQuerySource(run.querySource)
        ? applyTurnTierEffort(toolUseContext.agentId, iter.appState.effortValue)
        : iter.appState.effortValue
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
      if (pulseMain) {
        const truth = resolveEffortTruth(iter.currentModel, effortValue, { agentId: toolUseContext.agentId })
        const effortLabel = truth.wire === undefined ? undefined : truth.label
        notePulseModel(iter.currentModel, effortLabel)
        setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'dispatching', {
          model:
            getPublicModelDisplayName(iter.currentModel) ?? iter.currentModel,
          effort: effortLabel,
        })
      }
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
      try {
        let streamingFallbackOccured = false
        if (pulseMain) pulseMark('model_call_stream_start')
        for await (const message of run.deps.callModel({
          messages:
            latestUserContextBody(iter.messagesForQuery) === null
              ? prependUserContext(iter.messagesForQuery, run.userContext)
              : iter.messagesForQuery,
          systemPrompt: iter.fullSystemPrompt,
          thinkingConfig: toolUseContext.options.thinkingConfig,
          tools: toolUseContext.options.tools,
          signal: toolUseContext.abortController.signal,
          options: {
            async getToolPermissionContext() {
              const appState = toolUseContext.getAppState()
              return appState.toolPermissionContext
            },
            model: iter.currentModel,
            toolChoice: undefined,
            isNonInteractiveSession:
              toolUseContext.options.isNonInteractiveSession,
            fallbackModel: run.fallbackModel,
            onStreamingFallback: () => {
              streamingFallbackOccured = true
            },
            onWait: wait => toolUseContext.setSDKStatus?.({ wait }),
            querySource: run.querySource,
            agents: toolUseContext.options.agentDefinitions.activeAgents,
            allowedAgentTypes:
              toolUseContext.options.agentDefinitions.allowedAgentTypes,
            hasAppendSystemPrompt: !!toolUseContext.options.appendSystemPrompt,
            maxOutputTokensOverride: iter.maxOutputTokensOverride,
            fetchOverride: iter.dumpPromptsFetch,
            mcpTools: iter.appState.mcp.tools,
            hasPendingMcpServers: iter.appState.mcp.clients.some(
              c => c.type === 'pending',
            ),
            callReference,
            queryTracking,
            effortValue,
            advisorModel: iter.appState.advisorModel,
            skipCacheWrite: run.skipCacheWrite,
            agentId: toolUseContext.agentId,
            ownerKey: String(rosterOwnerFromToolUseContext(toolUseContext)),
            addNotification: toolUseContext.addNotification,
            ...(run.params.taskBudget && {
              taskBudget: run.budgetGuard.requestBag()!,
            }),
          },
        })) {
          if (streamingFallbackOccured) {
            streamingFallbackOccured = false
            for (const msg of iter.assistantMessages) {
              yield emit({ kind: 'assistant_retracted', message: msg })
            }

            iter.needsFollowUp = resetForRetry(iter).needsFollowUp
          }
          const yieldMessage: typeof message = backfillCloneForYield(
            message,
            name => findToolByName(toolUseContext.options.tools, name),
          )
          if (message.type === 'assistant') {
            yield emit({
              kind: 'assistant_settled',
              callId,
              message: yieldMessage,
              withheld:
                isWithheldMaxOutputTokens(message) ||
                (overflowSignalOf(message) !== null && overflowLadderArmed(run.querySource)),
            })
            iter.assistantMessages.push(message)
            if (!responsesClassified.has(message.message.id)) {
              rememberClassifiedResponse(message.message.id)
              const drops = inputTransformationsOf(message.message)
              const outcome = classifyThinkingDrops(
                String(ownerFromToolUseContext(toolUseContext)),
                drops,
                prefixMarkOf(iter.messagesForQuery, iter.currentModel, {
                  permissionMode: toolUseContext.getAppState().toolPermissionContext.mode,
                }),
              )
              const prefixVerdict = takePrefixVerdict(String(rosterOwnerFromToolUseContext(toolUseContext)))
              const rewrite = prefixVerdict?.mismatch ?? null
              if (rewrite !== null && outcome.kind !== 'none' && outcome.lawful === null) outcome.part = rewrite.part
              if (outcome.kind !== 'none') {
                recordThinkingDropLedger(outcome, iter.currentModel)
                logForDebugging(`preserved thinking: ${JSON.stringify(drops)}`, { level: 'warn' })
              }
              const dropNotice = describeThinkingDrops(drops, outcome)
              if (dropNotice !== null) {
                yield emit({ kind: 'notice', message: createSystemMessage(dropNotice, 'warning') })
              } else if (rewrite !== null && outcome.kind === 'none') {
                recordPrefixRewriteLedger(rewrite.part, rewrite.path, iter.currentModel)
                yield emit({ kind: 'notice', message: createSystemMessage(describePrefixRewrite(rewrite.part, rewrite.path), 'warning') })
              }
              const dead = deadMarksFromDrops(drops, prefixVerdict?.wireMessageIds ?? [], deadThinkingMarks(iter.messagesForQuery))
              if (dead.length > 0) {
                logForDebugging(`preserved thinking: ${dead.length} dropped block(s) marked dead on the record (${dead.map(mark => `${mark.messageId}#${mark.blockIndex}`).join(', ')})`)
                yield emit({ kind: 'notice', message: createThinkingDeadMessage(dead, `${dead.length} dropped thinking ${dead.length === 1 ? 'block' : 'blocks'} left off every later request`) })
              }
            }
            if (toolUseContext.agentId == null) {
              const boundRecord = await boundPrefixRecordToEmit(
                String(rosterOwnerFromToolUseContext(toolUseContext)),
                iter.messagesForQuery,
                iter.currentModel,
              )
              if (boundRecord !== null) yield emit({ kind: 'attachment', message: boundRecord })
            }
            if (callId === `${iter.turnId}.c1`) {
              const u = (message.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }).usage
              const measured = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
              if (measured > 0) {
                reconcileAppliedPlanUsage(ownerFromToolUseContext(toolUseContext), measured)
              }
            }

            const msgToolUseBlocks = message.message.content.filter(
              content => content.type === 'tool_use',
            ) as ToolUseBlock[]
            if (msgToolUseBlocks.length > 0) {
              iter.toolUseBlocks.push(...msgToolUseBlocks)
              iter.needsFollowUp = true
            }
          } else {
            if (pulseMain && yieldMessage.type === 'stream_event') {
              const ev = (yieldMessage as { event?: { type?: string; content_block?: { type?: string }; delta?: { type?: string } } }).event
              if (
                ev?.type === 'content_block_start' &&
                (ev.content_block?.type === 'thinking' ||
                  ev.content_block?.type === 'redacted_thinking')
              ) {
                pulseMark('first_thinking_event')
              } else if (
                ev?.type === 'content_block_delta' &&
                ev.delta?.type === 'text_delta'
              ) {
                pulseMark('first_text_delta')
              }
            }
            yield emit({ kind: 'stream_delta', callId, raw: yieldMessage })
          }
        }
        if (pulseMain) pulseMark('model_call_stream_end')
        for (const settled of iter.assistantMessages) {
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
      } catch (innerError) {
        if (innerError instanceof FallbackTriggeredError && run.fallbackModel) {
          iter.currentModel = run.fallbackModel
          attemptWithFallback = true

          yield* emitSyntheticSettlements(
            iter.assistantMessages,
            'Model fallback triggered',
            'error',
            emit,
          )
          iter.needsFollowUp = resetForRetry(iter).needsFollowUp

          toolUseContext.options.mainLoopModel = run.fallbackModel


          yield emit({
            kind: 'notice',
            message: createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            ),
          })

          continue
        }
        throw innerError
      } finally {
        releaseModelPermitByCall(permitKey)
      }
    }
  } catch (error) {
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

    logAntError('Query error', error)
    return { kind: 'terminal', terminal: { reason: 'model_error', error } }
  }

  return { kind: 'streamed' }
}


export async function* runEventCore(
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

  const owningPulseGeneration = getActivePulseTrace()?.generation ?? -1

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

  const budgetGuard = new BudgetGuard(params.taskBudget)

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

  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  let iterationOrdinal = 0

  let checkpointSettleWarned = false

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

    const ordinal = ++iterationOrdinal
    const turnId = `t${ordinal}`
    yield emit({ kind: 'turn_started', turnId, n: ordinal })

    const pulseMain = isPulseMainSource(querySource, toolUseContext.agentId)
    if (pulseMain) pulseMark('iteration_started', { n: ordinal })

    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const chainIdForAnalytics =
      queryTracking.chainId

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let tracking = autoCompactTracking

    if (pulseMain) {
      pulseStageStart('request_context_plan')
      setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'preparing', {
        reason: 'context',
      })
    }
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    const requestPlan = await buildRequestContextPlan(
      {
        messages,
        owner: ownerFromToolUseContext(toolUseContext),
        querySource,
        contentReplacementState: toolUseContext.contentReplacementState,
        persistReplacements: persistReplacements
          ? records =>
              void recordContentReplacement(
                records,
                toolUseContext.agentId,
              ).catch(logError)
          : undefined,
        skipToolNames: new Set(
          toolUseContext.options.tools
            .filter(t => !Number.isFinite(t.maxResultSizeChars))
            .map(t => t.name),
        ),
        microcompact: deps.microcompact,
        readFileState: toolUseContext.readFileState,
        calibrationKey: (() => {
          const model = toolUseContext.options.mainLoopModel
          return typeof model === 'string' && model
            ? calibrationKeyFor(declaredRouteOf(model) ?? 'unrecognised', model)
            : null
        })(),
        harnessContextPolicy: harnessContextPolicyRequest(
          typeof toolUseContext.options.mainLoopModel === 'string'
            ? toolUseContext.options.mainLoopModel
            : null,
          toolUseContext.getAppState?.()?.effortValue,
        ),
        ...(pendingOverflow?.rung === 'prune' ? { pressurePrune: true as const } : {}),
      },
      'apply',
    )
    let messagesForQuery = requestPlan.messages
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
    if (pulseMain) pulseStageEnd('request_context_plan')

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    const forcedFold = pendingOverflow?.rung === 'fold' ? pendingOverflow.signal : undefined
    const foldSplit =
      forcedFold !== undefined
        ? splitCarriedOperatorTail(messagesForQuery)
        : { head: messagesForQuery, carry: [] as Message[], hasHistory: true }
    if (pulseMain) pulseStageStart('autocompact')
    const {
      compactionResult,
      consecutiveFailures,
      consecutiveRapidRefills,
      rapidRefillBreakerTripped,
      measuredRawTokenCount,
      refusal: forcedFoldRefusal,
    } = await deps.autocompact(
      foldSplit.head,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: foldSplit.head,
      },
      querySource,
      tracking,
      0,
      forcedFold,
    )
    if (pulseMain)
      pulseStageEnd('autocompact', { compacted: Boolean(compactionResult) })

    if (rapidRefillBreakerTripped) {
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: AUTOCOMPACT_THRASH_MESSAGE,
          error: 'invalid_request',
        }),
      })
      const terminal: Terminal = { reason: 'rapid_refill_breaker' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (forcedFold !== undefined && !compactionResult) {
      yield emit({
        kind: 'notice',
        message: createAssistantAPIErrorMessage({
          content: overflowRefusalText(forcedFold, 'fold-failed', {
            nonInteractive: toolUseContext.options.isNonInteractiveSession === true,
            ...(forcedFoldRefusal !== undefined ? { detail: forcedFoldRefusal } : {}),
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

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      const postForTrace = truePostCompactTokenCount ?? postCompactTokenCount
      emitCompactionTrace('auto-compact', {
        tokensFreed:
          typeof preCompactTokenCount === 'number' &&
          typeof postForTrace === 'number'
            ? preCompactTokenCount - postForTrace
            : undefined,
      })


      if (params.taskBudget) {
        budgetGuard.applyCompactionCarryover(
          finalContextTokensFromLastResponse(messagesForQuery),
        )
      }

      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
        consecutiveRapidRefills,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      yield emit({
        kind: 'compaction_boundary',
        trigger: forcedFold !== undefined ? 'overflow' : 'auto',
        messages: postCompactMessages,
      })

      messagesForQuery = [...postCompactMessages, ...foldSplit.carry]
      overflowEpisode = { pruned: overflowEpisode.pruned, folded: true }
    } else if (consecutiveFailures !== undefined) {
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    if (pulseMain) pulseStageStart('model_assembly')
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'strategy' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })
    if (isTurnOwningQuerySource(querySource)) {
      currentModel = applyTurnTierModel(toolUseContext.agentId, currentModel)
    }

    if (pulseMain) pulseStageEnd('model_assembly')

    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    const justCompactedUnderLimit =
      compactionResult !== undefined &&
      (compactionResult.truePostCompactTokenCount === undefined ||
        calculateTokenWarningState(
          compactionResult.truePostCompactTokenCount,
          toolUseContext.options.mainLoopModel,
        ).level !== 'blocked')
    if (
      !justCompactedUnderLimit &&
      querySource !== 'compact' &&
      querySource !== 'session_memory'
    ) {
      const estimatedTokens =
        compactionResult?.truePostCompactTokenCount ??
        measuredRawTokenCount ??
        tokenCountWithEstimation(messagesForQuery, toolUseContext.options.mainLoopModel)
      const { level } = calculateTokenWarningState(
        estimatedTokens,
        toolUseContext.options.mainLoopModel,
      )
      if (level === 'blocked') {
        if (overflowLadderArmed(querySource)) {
          const blockingLimit = getBlockingLimit(toolUseContext.options.mainLoopModel)
          const signal = estimateOverflowSignal({
            family: declaredRouteOf(currentModel) ?? 'unknown',
            actualTokens: estimatedTokens,
            limitTokens: blockingLimit,
          })
          const pruneSaving =
            projectTimeBasedMicrocompact(messagesForQuery, querySource, { pressure: true })?.tokensSaved ?? 0
          const headFoldFailed =
            (consecutiveFailures ?? 0) > (autoCompactTracking?.consecutiveFailures ?? 0)
          const decision = decideOverflowRecovery({
            episode: overflowEpisode,
            gapTokens: Math.max(1, estimatedTokens - blockingLimit),
            pruneSavingTokens: pruneSaving,
            fold: foldAvailability({
              tracking,
              headFold: headFoldFailed ? 'failed' : 'did-not-land',
              hasHistory: splitCarriedOperatorTail(messagesForQuery).hasHistory,
            }),
          })
          if (decision.kind === 'recover' && decision.rung === 'prune') {
            const next: TurnState = {
              messages: messagesForQuery,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              maxOutputTokensOverride,
              streamFaultRecoveryCount,
              toolCallRefusalRecoveryCount,
              pendingToolUseSummary,
              stopHookActive,
              turnCount,
              overflowEpisode: { pruned: true, folded: overflowEpisode.folded },
              pendingOverflow: { signal, rung: 'prune' },
              transition: { reason: 'overflow_recovery', rung: 'prune', source: 'estimate' },
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
                nonInteractive: toolUseContext.options.isNonInteractiveSession === true,
                ...(decision.kind === 'refuse' && decision.detail !== undefined ? { detail: decision.detail } : {}),
              }),
              error: 'invalid_request',
              overflow: signal,
            }),
          })
          const terminal: Terminal = { reason: 'blocking_limit' }
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
      messagesForQuery,
      toolUseContext,
      queryTracking,
      chainIdForAnalytics,
      tracking,
      fullSystemPrompt,
      appState,
      dumpPromptsFetch,
      currentModel,
      maxOutputTokensOverride,
      assistantMessages: [],
      toolResults: [],
      toolUseBlocks: [],
      needsFollowUp: false,
      callOrdinal: 0,
    }

    const streamOutcome = yield* streamModel(run, iter, emit)
    if (streamOutcome.kind === 'terminal') {
      yield emit({ kind: 'run_terminal', terminal: streamOutcome.terminal })
      return streamOutcome.terminal
    }
    const { assistantMessages, toolResults, toolUseBlocks } = iter
    const refusedToolCalls = collectRefusedToolCalls(assistantMessages)

    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    if (toolUseContext.abortController.signal.aborted) {
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

    if (!iter.needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      const overflow = overflowSignalOf(lastMessage)
      if (overflow !== null && overflowLadderArmed(querySource)) {
        const foldInput = [
          ...messagesForQuery,
          ...assistantMessages.filter(m => m.isApiErrorMessage !== true),
        ]
        const split = splitCarriedOperatorTail(foldInput)
        const pruneSaving =
          projectTimeBasedMicrocompact(foldInput, querySource, { pressure: true })?.tokensSaved ?? 0
        const decision = decideOverflowRecovery({
          episode: overflowEpisode,
          gapTokens: overflowGapFor(overflow),
          pruneSavingTokens: pruneSaving,
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
              nonInteractive: toolUseContext.options.isNonInteractiveSession === true,
              ...(decision.detail !== undefined ? { detail: decision.detail } : {}),
            }),
            error: 'invalid_request',
            ...(overflow.detail !== undefined ? { errorDetails: overflow.detail } : {}),
            overflow,
          }),
        })
        const terminal: Terminal = { reason: 'prompt_too_long' }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }

      if (isWithheldMaxOutputTokens(lastMessage)) {
        const decision = decideMaxOutputTokensRecovery({
          capEnabled: getFeatureValue_CACHED_MAY_BE_STALE(
            'mercury_otk_slot_v1',
            false,
          ),
          envPinned: !!process.env.MERCURY_MAX_OUTPUT_TOKENS,
          maxOutputTokensOverride,
          recoveryCount: maxOutputTokensRecoveryCount,
        })

        if (decision.kind === 'escalate') {
          const next: TurnState = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            streamFaultRecoveryCount,
            toolCallRefusalRecoveryCount,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            overflowEpisode,
            pendingOverflow: undefined,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          yield emit({ kind: 'turn_settled', transition: next.transition! })
          state = next
          continue
        }

        if (decision.kind === 'nudge') {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
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
            maxOutputTokensOverride: undefined,
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

        yield emit({ kind: 'withheld_surfaced', message: lastMessage })
      }

      if (lastMessage && isContinuableStreamFaultMessage(lastMessage)) {
        const decision = decideStreamFaultRecovery({
          continuableTail: true,
          recoveryCount: streamFaultRecoveryCount,
        })
        if (decision.kind === 'continue') {
          yield emit({
            kind: 'notice',
            message: createSystemMessage(
              'Stream dropped after partial content — continuing once from where it stopped.',
              'warning',
            ),
          })
          const recoveryMessage = createUserMessage({
            content: STREAM_FAULT_RECOVERY_NUDGE,
            isMeta: true,
          })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
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
          const correction = createUserMessage({
            content: toolCallRefusalCorrection(refusedToolCalls),
            isMeta: true,
          })
          const next: TurnState = {
            messages: [...messagesForQuery, ...assistantMessages, correction],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
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
      }

      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
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

      const terminal: Terminal = { reason: 'completed' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    if (pulseMain) {
      pulseStageStart('tool_execution', { toolCount: toolUseBlocks.length })
      setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'tool-work', {
        toolCount: toolUseBlocks.length,
      })
    }

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
    )

    for await (const update of toolUpdates) {
      if (update.message) {
        yield toolUpdateEvent(update.message, emit)

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    if (pulseMain) pulseStageEnd('tool_execution')

    if (refusedToolCalls.length > 0) {
      const correction = createUserMessage({
        content: toolCallRefusalCorrection(refusedToolCalls),
        isMeta: true,
      })
      yield emit({ kind: 'hook_message', message: correction })
      toolResults.push(correction)
    }

    const briefTerminalTurn = isBriefTerminalTurn(
      querySource,
      toolUseContext,
      toolUseBlocks,
      toolResults,
    )

    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      !briefTerminalTurn &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId
    ) {
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
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

    {
      const stop = takeRepetitionStop(toolUseContext.abortController)
      if (stop !== null) {
        const cause = repetitionStopNotice(stop)
        yield emit({
          kind: 'notice',
          message: createSystemMessage(cause, 'warning'),
        })
        yield emit({
          kind: 'attachment',
          message: createAttachmentMessage({
            type: 'repetition_breaker',
            toolName: stop.toolName,
            outcome: stop.outcome,
            streak: stop.streak,
            cause,
          }),
        })
        const terminal: Terminal = { reason: 'repetition_breaker', cause }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }
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

    if (briefTerminalTurn) {
      const stopHookResult = yield* runStopHookGate(
        handleStopHooks(
          [...messagesForQuery, ...assistantMessages, ...toolResults],
          [],
          systemPrompt,
          userContext,
          systemContext,
          { ...updatedToolUseContext, queryTracking },
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
            ...toolResults,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext: { ...updatedToolUseContext, queryTracking },
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

      const terminal: Terminal = { reason: 'completed' }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
    }


    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
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
        null,
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

    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield emit({ kind: 'attachment', message: msg })
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
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


    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    const nextTurnCount = turnCount + 1

    if (
      maxTurns !== undefined &&
      budgetGuard.maxTurnsExceeded(nextTurnCount, maxTurns)
    ) {
      yield emit({
        kind: 'attachment',
        message: createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCount,
        }),
      })
      const terminal: Terminal = { reason: 'max_turns', turnCount: nextTurnCount }
      yield emit({ kind: 'run_terminal', terminal })
      return terminal
    }

    let cycleReplanInjected = state.cycleReplanInjected === true
    const cycleDirectiveMessages: Message[] = []
    {
      const leaseOwner = ownerFromToolUseContext(updatedToolUseContext)
      const lease = evaluateCycleLease(
        getRunSnapshot(leaseOwner),
        cycleReplanInjected,
      )
      if (lease.action === 'settle') {
        noteRunEvent(leaseOwner, {
          type: 'stop-decision',
          at: Date.now(),
          decision: 'handoff',
          detail: lease.cause,
        })
        yield emit({
          kind: 'attachment',
          message: createAttachmentMessage({
            type: 'cycle_handoff',
            cause: lease.cause,
            unfinished: lease.unfinished,
            report: renderHandoffReport(lease.report),
          }),
        })
        const terminal: Terminal = { reason: 'cycle_handoff', cause: lease.cause }
        yield emit({ kind: 'run_terminal', terminal })
        return terminal
      }
      if (lease.action === 'replan') {
        cycleReplanInjected = true
        cycleDirectiveMessages.push(
          createUserMessage({ content: lease.directive, isMeta: true }),
        )
        for (const m of cycleDirectiveMessages) {
          yield emit({ kind: 'hook_message', message: m })
        }
      }
    }

    const next: TurnState = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults, ...cycleDirectiveMessages],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      streamFaultRecoveryCount: 0,
      toolCallRefusalRecoveryCount: 0,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
      cycleReplanInjected,
      overflowEpisode: FRESH_OVERFLOW_EPISODE,
      pendingOverflow: undefined,
    }
    yield emit({ kind: 'turn_settled', transition: next.transition! })
    state = next
  }
}
