
import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { AnthropicClientOptions as ClientOptions } from './anthropicClient.js'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '../../api/sdkErrors.js'
import type { ContentBlock as BetaContentBlock, ApiStreamEvent as BetaRawMessageStreamEvent } from '../../../types/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from './anthropicWire.js'
import type { AnthropicStream } from './anthropicStream.js'
import {
  getCacheEditingHeaderLatched,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import type { AgentId } from 'src/types/ids.js'
import type { NativeWebSearchRequest } from 'src/services/search/nativeSearchRequest.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { EffortValue } from 'src/utils/effort.js'
import { resetApiConnectionPool } from 'src/utils/proxy.js'
import type { ThinkingConfig } from 'src/utils/thinking.js'
import {
  getEmptyToolPermissionContext,
  type ToolCallChain,
  type ToolPermissionContext,
  type Tools,
} from '../../../Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import { planToolPayload } from '../toolEconomy.js'
import type { ConnectorTextBlock } from '../../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../../types/message.js'
import type {
  ApiToolUnion,
  JsonOutputFormat,
  StreamCapabilityAdvertisement,
} from '../../../types/wire.js'
import { toolToAPISchema } from '../../../utils/api.js'
import { resolveAppliedEffort, resolveEffortTruth } from '../../../utils/effort.js'
import { effortStampOf } from '../../../utils/effortStamp.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { errorMessage } from '../../../utils/errors.js'
import { fitImagesToRequestCap, manyImageLimitStatedIn } from '../../../utils/imageResizer.js'
import { captureAPIRequest } from '../../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
} from '../../../utils/messages.js'
import { processOwnerForLane } from '../../../utils/run/resolveOwner.js'
import { utilityCallFor } from '../../../utils/model/utilityModel.js'
import { startSessionActivity } from '../../../utils/sessionActivity.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../../utils/systemPromptType.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
} from '../../compact/microCompact.js'
import { withStreamingVCR, withVCR } from '../../vcr.js'
import { transportCutOf } from '../../api/transportEvidence.js'
import { captureModelRefusalRequest, type ModelRefusalRequest } from './modelRefusal.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getErrorMessageIfRefusal,
  malformedStreamFrameText,
} from '../../api/errors.js'
import { EMPTY_USAGE } from '../../api/logging.js'
import type { ModelCallReference } from '../../../run-core/call-reference.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  retryEmptyStream,
} from '../../api/withRetry.js'
import type { HeldBusyRetryWait } from '../busyRetry.js'
import { emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { toolCallRefusalNote } from '../toolCallGate.js'
import { safeParseJSON } from '../../../utils/json.js'
import type { RefusedToolCall } from '../../../types/message.js'
import type { RequestWaitV1 } from '../streamIdleBudget.js'
import { anthropicEffortWireFact } from './requestParams.js'
type BetaToolChoiceAuto = Extract<BetaMessageStreamParams['tool_choice'], { type: 'auto' }>
type BetaToolChoiceTool = Extract<BetaMessageStreamParams['tool_choice'], { type: 'tool' }>
type BetaToolChoiceNone = Extract<BetaMessageStreamParams['tool_choice'], { type: 'none' }>
import type { CallState, QueryCtx, StreamPass } from './streamCore/state.js'
import { createCallLedger } from './streamCore/callLedger.js'
import { executeNonStreamingRequest } from './streamCore/nonStreaming.js'
import { streamPassRetries, retryWaitOf } from './streamCore/passRetries.js'
import { preEventReissueRow, streamCutReissueRow, oneShotNoticeRow, oneShotAnswerOf, streamCreation404Row } from './streamCore/reissueRows.js'
import { failedRequestRows } from './streamCore/requestFailed.js'
import { messagesBeforeImages, requestBetas, toolRosterOf, wireRequestOf } from './streamCore/requestPlan.js'
import { closeSucceededRequest, settleAttemptLedger } from './streamCore/settleCall.js'
import { openStreamPass, resetStreamAttempt, noteStreamEvent, startMessage, openContentBlock, applyBlockDelta, settleMessageDelta, noteWatchdogCleanExit, observeStreamEnd, noteWatchdogErrorExit, sdkAbortError } from './streamCore/streamEvents.js'
import { watchStream } from './streamCore/watchStream.js'
import { wireParamsFor } from './streamCore/wireParams.js'

export const ANTHROPIC_STREAM_ADVERTISEMENT: StreamCapabilityAdvertisement = {
  textDelta: true,
  reasoningDelta: true,
  toolArgsDelta: true,
  usage: true,
  timing: true,
}

export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | BetaToolChoiceNone | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: ApiToolUnion[]
  nativeWebSearch?: NativeWebSearchRequest
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  onWait?: (wait: RequestWaitV1 | null) => void
  onStreamActivity?: (atMs: number) => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  effortPinned?: boolean
  ridesSessionEffort?: boolean
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  callChain?: ToolCallChain
  agentId?: AgentId
  ownerKey?: string
  outputFormat?: JsonOutputFormat
  addNotification?: (notif: Notification) => void
  callReference?: ModelCallReference
}

export {
  accumulateUsage,
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  cleanupStream,
  updateUsage,
} from './cacheAndUsage.js'

export async function queryModelWithoutStreaming(
  request: CallModelParams,
): Promise<AssistantMessage> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = request
  const settled: AssistantMessage[] = []
  const stream = withStreamingVCR(messages, () =>
    queryModel(messages, systemPrompt, thinkingConfig, tools, signal, options),
  )
  for await (const item of stream) {
    if (item.type === 'assistant') settled.push(item)
  }
  const last = settled.at(-1)
  if (last) return last
  throw signal.aborted ? new APIUserAbortError() : new Error('No assistant message found')
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: CallModelParams): CallModelStream {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

const NO_EVENTS_MESSAGE = 'Stream ended without receiving any events'
const EMPTY_CLOSE_DETAIL = 'closed with no events'

function spokenByProvider(error: unknown): boolean {
  return error instanceof APIError && !(error instanceof APIConnectionError)
}

export { executeNonStreamingRequest } from './streamCore/nonStreaming.js'

export function cutToolCallOf(block: { type: string; id?: string; name?: string; input?: unknown }): RefusedToolCall | null {
  if (block.type !== 'tool_use' || typeof block.input !== 'string' || block.input.length === 0) return null
  if (safeParseJSON(block.input, false) !== null) return null
  return {
    id: block.id ?? '',
    name: block.name ?? '',
    argumentsRaw: block.input,
    argumentsLength: block.input.length,
    code: 'invalid-json',
    reason: `the arguments were not valid JSON (${block.input.length} characters arrived before the reply ended)`,
  }
}

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage,
  void
> {

  const { captureSignInRequest, observeSignInResponse } = require('../../../utils/accounts/signInRefusal.js') as typeof import('../../../utils/accounts/signInRefusal.js')
  const resolvedModel = options.model
  const modelRefusalRequest: { current?: ModelRefusalRequest } = {}
  const effortPinned = options.effortPinned === true
  const effortTruth = resolveEffortTruth(options.model, options.effortValue, { agentId: options.agentId, pinned: effortPinned })
  const effortRides = effortPinned || options.ridesSessionEffort !== false
  const effortAsked = effortRides ? effortTruth.requested : undefined
  const call: CallState = {
    signInRequest: undefined,
    effortOnWire: effortStampOf(effortAsked, effortTruth.supportsEffort ? { kind: 'omitted' } : { kind: 'unsupported' }),
    start: 0,
    stream: undefined,
    streamRequestId: undefined,
    clientRequestId: undefined,
    streamResponse: undefined,
    sentThinkingPrefix: undefined,
    ledgerFirstDifference: null,
    ttftMs: 0,
    partialMessage: undefined,
    usage: EMPTY_USAGE,
    servedModel: undefined,
    stopReason: null,
    ledgerSettled: false,
    didFallBackToNonStreaming: false,
    fallbackMessage: undefined,
    maxOutputTokens: 0,
    preFirstEventStreamRetryUsed: false,
    streamCutRetryUsed: false,
    emptyStreamEnds: 0,
    settledNormally: false,
  }
  const captureModelRequest = (params: BetaMessageStreamParams): void => {
    modelRefusalRequest.current = captureModelRefusalRequest(params.model)
    call.effortOnWire = effortStampOf(effortAsked, anthropicEffortWireFact(params as Parameters<typeof anthropicEffortWireFact>[0], effortTruth.supportsEffort))
    call.signInRequest = captureSignInRequest('anthropic')
    captureAPIRequest(params, options.querySource)
  }

  const betas = requestBetas(options)

  const rosterOwnerKey = options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null))
  const plan = await planToolPayload({
    model: options.model,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
    latchKey: rosterOwnerKey,
  })
  const { useToolSearch, blockForm, filteredTools, willDefer } = toolRosterOf(plan, betas, tools, options, rosterOwnerKey)

  const cachedMCEnabled = false

  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: filteredTools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
        conversationKey: plan.conversationKey,
        bound: plan.isBound(tool.name),
      }),
    ),
  )

  const unfittedMessages = messagesBeforeImages(messages, filteredTools, useToolSearch, blockForm, rosterOwnerKey)
  const fittedImages = await fitImagesToRequestCap(unfittedMessages, { model: options.model, owner: rosterOwnerKey, statedSidePx: manyImageLimitStatedIn(messages) })
  const planned = wireRequestOf(fittedImages, messages, systemPrompt, thinkingConfig, options, rosterOwnerKey, toolSchemas)
  const { messagesForAPI, prefixKey, turnOwning } = planned

  const cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true

  const effort = effortRides ? resolveAppliedEffort(options.model, options.effortValue, { agentId: options.agentId, pinned: effortPinned }) : undefined

  const startIncludingRetries = Date.now()
  call.start = Date.now()

  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []
  const paramsFromContext = wireParamsFor(call, { messages, thinkingConfig, options, betas, rosterOwnerKey, planned, cachedMCEnabled, cacheEditingHeaderLatched, effort, consumedCacheEdits, consumedPinnedEdits })

  const newMessages: AssistantMessage[] = []
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  const stoppedBlockIndices = new Set<number>()
  const ledger = createCallLedger(call, tools, options, resolvedModel, newMessages, contentBlocks, stoppedBlockIndices, observeSignInResponse)

  const heldWaitDoor = options.agentId !== undefined ? (wait: HeldBusyRetryWait): void => options.onWait?.(wait) : undefined
  const ctx: QueryCtx = { messages, thinkingConfig, signal, options, modelRefusalRequest, captureModelRequest, observeSignInResponse, rosterOwnerKey, prefixKey, turnOwning, messagesForAPI, startIncludingRetries, paramsFromContext, heldWaitDoor, newMessages, contentBlocks, stoppedBlockIndices, ...ledger }
  yield* streamCall(ctx, call)
}

async function* streamCall(ctx: QueryCtx, call: CallState): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage,
  void
> {
  const { messages, thinkingConfig, signal, options, captureModelRequest, rosterOwnerKey, prefixKey, turnOwning, startIncludingRetries, paramsFromContext, heldWaitDoor, newMessages, contentBlocks, stoppedBlockIndices, releaseStreamResources, noteServedModel, pricingModel, mintAssistantMessage, yieldAbortedPartialText, settleUnpricedAttempt } = ctx
  try {
    streamingPass: for (;;) {
    const pass: StreamPass = openStreamPass()
    const generator = streamPassRetries(call, pass, { messages, thinkingConfig, signal, options, paramsFromContext, captureModelRequest, rosterOwnerKey, heldWaitDoor })

    let e
    do {
      e = await generator.next()
      if (!('controller' in e.value)) {
        const notice = e.value as SystemAPIErrorMessage
        if (notice.type === 'system' && notice.subtype === 'api_error') {
          const retryWait: RequestWaitV1 = retryWaitOf(notice)
          options.onWait?.(retryWait)
        }
        yield e.value
      }
    } while (!e.done)
    call.stream = e.value as AnthropicStream

    resetStreamAttempt(call, settleUnpricedAttempt, newMessages, contentBlocks, stoppedBlockIndices)
    const { STREAM_IDLE_TIMEOUT_MS, modelWords, preEventSilenceWords, streamIdleWatchdog, activityRelay, clearStreamIdleTimers, settledTailType, settledTailStands, settleTypedEnd } = watchStream(ctx, call, pass)

    startSessionActivity('api_call')
    try {
      for await (const part of call.stream) {
        noteStreamEvent(pass, streamIdleWatchdog, activityRelay, options)

        switch (part.type) {
          case 'message_start': {
            startMessage(call, part, noteServedModel)
            break
          }
          case 'content_block_start':
            openContentBlock(contentBlocks, part)
            break
          case 'content_block_delta': {
            applyBlockDelta(contentBlocks, part)
            break
          }
          case 'content_block_stop': {
            const row = blockStopRow(ctx, call, pass, part)
            yield row
            break
          }
          case 'message_delta': {
            if (part.delta == null) {
              throw new Error(malformedStreamFrameText('message_delta', 'delta'))
            }
            settleMessageDelta(call, part, newMessages, pricingModel, options, messages)

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
              { requestId: call.clientRequestId ?? null, raw: part.delta },
            )
            if (refusalMessage) {
              yield { ...refusalMessage, effort: call.effortOnWire }
            }

            if (call.stopReason === 'max_tokens') {
              yield maxOutputTokensRow(call)
            }

            if (call.stopReason === 'model_context_window_exceeded') {
              yield contextWindowRow(call)
            }
            break
          }
          case 'message_stop':
            pass.sawMessageStop = true
            setLastApiCompletionTimestamp(Date.now())
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs: call.ttftMs } : undefined),
        }
        if (pass.sawMessageStop) break
      }
      clearStreamIdleTimers()

      if (signal.aborted) {
        yield* yieldAbortedPartialText()
        releaseStreamResources()
        return
      }

      if (pass.streamIdleAborted) {
        noteWatchdogCleanExit(pass)
        if (settledTailStands()) {
          yield* settleTypedEnd({
            reason: 'silent-after-last-item',
            provider: 'Anthropic',
            silentMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS,
          })
        } else {
          throw new Error('Stream idle timeout - no chunks received')
        }
      }

      if (!call.partialMessage || (newMessages.length === 0 && !call.stopReason)) {
        logForDebugging(
          !call.partialMessage
            ? 'stream closed before message_start'
            : 'stream closed after message_start with no completed block and no stop_reason — routing to the non-streaming fallback',
          { level: 'error' },
        )
        throw new Error(NO_EVENTS_MESSAGE)
      }
      if (call.stopReason === null) {
        if (settledTailStands()) {
          yield* settleTypedEnd({ reason: 'closed-after-last-item', provider: 'Anthropic' })
        } else if (settledTailType() === 'tool_use') {
          yield* settleTypedEnd({ reason: 'closed-after-last-item', provider: 'Anthropic' }, 'tool_use')
        } else {
          logForDebugging(
            'stream closed with no stop_reason and a block still open, or a settled tail that is neither text nor a tool call — routing to the non-streaming fallback',
            { level: 'error' },
          )
          throw new Error(NO_EVENTS_MESSAGE)
        }
      }

      observeStreamEnd(call, pass, turnOwning, prefixKey)
    } catch (streamingError) {
      clearStreamIdleTimers()

      if (pass.streamIdleAborted && pass.streamWatchdogFiredAt !== null) {
        noteWatchdogErrorExit(pass as StreamPass & { streamWatchdogFiredAt: number })
      }

      if (pass.streamIdleAborted && !signal.aborted && settledTailStands()) {
        yield* settleTypedEnd({
          reason: 'silent-after-last-item',
          provider: 'Anthropic',
          silentMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS,
        })
        break
      }

      if (streamingError instanceof APIUserAbortError) throw sdkAbortError(signal, streamingError)

      if (!pass.sawFirstStreamEvent && !pass.streamIdleAborted && !signal.aborted && !spokenByProvider(streamingError)) {
        const cutBeforeEvents = transportCutOf(streamingError)
        const detail = cutBeforeEvents !== null ? cutBeforeEvents.code : errorMessage(streamingError) === NO_EVENTS_MESSAGE ? EMPTY_CLOSE_DETAIL : errorMessage(streamingError)
        const empty = yield* retryEmptyStream(call, { provider: 'Anthropic', detail, cause: streamingError, log: '', signal, whilePaused: resetApiConnectionPool, ...(options.onWait !== undefined ? { onWait: options.onWait } : {}) })
        if (empty === 'cancelled') throw new APIUserAbortError()
        if (empty === 'again') continue streamingPass
        logForDebugging(`${emptyStreamSpentWords('Anthropic', Date.now() - startIncludingRetries)} (${detail})`, { level: 'error' })
        throw new Error(`${emptyStreamSpentWords('Anthropic', Date.now() - startIncludingRetries)} — ${detail}; try again shortly`)
      }

      const disableFallback =
        isEnvTruthy(flagEnv('MERCURY_DISABLE_NONSTREAMING_FALLBACK')) ||
        (pass.streamIdleAborted && pass.streamedToolUse)

      if (disableFallback) {
        logForDebugging(
          `The stream failed and the one-shot retry is off: ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      }

      if (
        pass.streamIdleAborted &&
        !pass.sawFirstStreamEvent &&
        !call.preFirstEventStreamRetryUsed
      ) {
        yield preEventReissueRow(call, streamingError, preEventSilenceWords, STREAM_IDLE_TIMEOUT_MS)
        continue streamingPass
      }

      const cut = signal.aborted ? null : transportCutOf(streamingError)
      if (cut !== null && !pass.streamedToolUse && !call.streamCutRetryUsed) {
        yield streamCutReissueRow(call, options, cut)
        continue streamingPass
      }

      yield oneShotNoticeRow(call, pass, options, streamingError, cut, STREAM_IDLE_TIMEOUT_MS, streamIdleWatchdog, preEventSilenceWords)

      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource, fetchOverride: options.fetchOverride },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: options.querySource,
          ...(heldWaitDoor !== undefined ? { onHeldWait: heldWaitDoor } : {}),
        },
        paramsFromContext,
        (_attempt, _startTime, tokens) => {
          call.maxOutputTokens = tokens
        },
        captureModelRequest,
        call.streamRequestId,
        pass.streamIdleAborted
          ? { idleMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS, model: modelWords }
          : undefined,
      )

      const m = oneShotAnswerOf(call, result, noteServedModel, mintAssistantMessage, newMessages, options, rosterOwnerKey)
      yield m
    } finally {
      clearStreamIdleTimers()
    }
    break
    }
    call.settledNormally = true
  } catch (errorFromRetry) {
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    const is404StreamCreationError =
      !call.didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      yield streamCreation404Row(call, options, errorFromRetry.originalError as APIError)

      try {
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource, fetchOverride: options.fetchOverride },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            signal,
            ...(heldWaitDoor !== undefined ? { onHeldWait: heldWaitDoor } : {}),
          },
          paramsFromContext,
          (_attempt, _startTime, tokens) => {
            call.maxOutputTokens = tokens
          },
          captureModelRequest,
          failedRequestId,
        )

        const m = oneShotAnswerOf(call, result, noteServedModel, mintAssistantMessage, newMessages, options, rosterOwnerKey)
        yield m

      } catch (fallbackError) {
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        logForDebugging(
          `The one-shot retry failed too: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        yield* failedRequestRows(ctx, fallbackError)
        releaseStreamResources()
        return
      }
    } else {
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      yield* failedRequestRows(ctx, errorFromRetry)
      releaseStreamResources()
      return
    }
  } finally {
    settleAttemptLedger(ctx, call)
  }

  closeSucceededRequest(ctx, call)
}

function blockStopRow(ctx: QueryCtx, call: CallState, pass: StreamPass, part: Extract<BetaRawMessageStreamEvent, { type: 'content_block_stop' }>) {
  const { contentBlocks, stoppedBlockIndices, newMessages, mintAssistantMessage } = ctx
  const contentBlock = contentBlocks[part.index]
  if (!contentBlock) {
    throw new RangeError('Content block not found')
  }
  if (!call.partialMessage) {
    throw new Error('Message not found')
  }
  const cutCall = cutToolCallOf(contentBlock)
  if (cutCall !== null) {
    const note = mintAssistantMessage(call.partialMessage, [
      { type: 'text', text: toolCallRefusalNote('anthropic', cutCall), citations: null },
    ] as BetaContentBlock[])
    note.refusedToolCalls = [cutCall]
    stoppedBlockIndices.add(part.index)
    newMessages.push(note)
    return note
  }
  const m = mintAssistantMessage(call.partialMessage, [
    contentBlock,
  ] as BetaContentBlock[])
  stoppedBlockIndices.add(part.index)
  if (contentBlock.type === 'tool_use') {
    pass.streamedToolUse = true
  }
  newMessages.push(m)
  return m
}

function maxOutputTokensRow(call: CallState) {
  return {
    ...createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response exceeded the ${
        call.maxOutputTokens
      } output token maximum. To configure this behavior, set the MERCURY_MAX_OUTPUT_TOKENS environment variable.`,
      apiError: 'max_output_tokens',
      error: 'max_output_tokens',
    }),
    effort: call.effortOnWire,
  }
}

function contextWindowRow(call: CallState) {
  return {
    ...createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response stopped at the model's context window limit.`,
      apiError: 'max_output_tokens',
      error: 'max_output_tokens',
    }),
    effort: call.effortOnWire,
  }
}

type UtilityOptions = Omit<Options, 'model' | 'getToolPermissionContext' | 'effortValue' | 'effortPinned' | 'ridesSessionEffort'>

export async function queryUtility({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: JsonOutputFormat
  signal: AbortSignal
  options: UtilityOptions
}): Promise<AssistantMessage> {
  const { thinkingConfig, ...call } = utilityCallFor()
  return queryWithModel({
    systemPrompt,
    userPrompt,
    outputFormat,
    signal,
    thinkingConfig,
    options: { ...options, ...call, effortPinned: true },
  })
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

type OneShotQuestion = {
  systemPrompt: SystemPrompt; userPrompt: string; outputFormat?: JsonOutputFormat
  signal: AbortSignal; options: QueryWithModelOptions; thinkingConfig?: ThinkingConfig
}

function sideQuestionParams(question: OneShotQuestion, systemPrompt: SystemPrompt): CallModelParams {
  return {
    messages: [createUserMessage({ content: question.userPrompt })], systemPrompt,
    thinkingConfig: question.thinkingConfig ?? { type: 'disabled' }, tools: [], signal: question.signal,
    options: {
      ridesSessionEffort: false, ...question.options, enablePromptCaching: question.options.enablePromptCaching ?? false,
      outputFormat: question.outputFormat, getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    },
  }
}

export async function queryWithModel(question: OneShotQuestion): Promise<AssistantMessage> {
  const { systemPrompt = asSystemPrompt([]), userPrompt, outputFormat, signal, options, thinkingConfig } = question
  question = { systemPrompt, userPrompt, outputFormat, signal, options, thinkingConfig }
  const { routedCallModel, settleAssistantTurn } = await import('../../providers/callModelRouter.js')
  const recordedInput = [
    createUserMessage({ content: systemPrompt.map(text => ({ type: 'text', text })) }),
    createUserMessage({ content: question.userPrompt }),
  ]
  const answer = async (): Promise<AssistantMessage[]> => {
    const stream = routedCallModel(sideQuestionParams(question, systemPrompt))
    const replies: AssistantMessage[] = []
    for await (const row of stream) if (row.type === 'assistant') replies.push(row)
    return [settleAssistantTurn(replies, question.signal.aborted)]
  }
  const [reply] = await withVCR(recordedInput, answer)
  return reply! as AssistantMessage
}

export { MAX_NON_STREAMING_TOKENS, adjustParamsForNonStreaming } from './streamCore/nonStreaming.js'

export { getMaxOutputTokensForModel } from './streamCore/wireParams.js'
