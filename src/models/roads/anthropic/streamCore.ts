import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import type { AnthropicClientOptions as ClientOptions } from './anthropicClient.js'
import { APIConnectionError, APIError, APIUserAbortError } from '../../../engine/request-parts/sdkErrors.js'
import type {
  AnthropicMessageParams as BetaMessageStreamParams,
} from './anthropicWire.js'
import type { ThinkingConfig } from 'src/models/effort/thinking.js'
import { getEmptyToolPermissionContext, type ToolCallChain, type ToolPermissionContext, type Tools } from '../../../tools/kit/tool.js'
import type { QuerySource } from 'src/engine/requests/querySource.js'
import type { Notification } from '../../../screen/notifications/notifications.js'
import type { ModelCallReference } from '../../../engine/loop/call-reference.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import { resolveAppliedEffort, resolveEffortTruth, type EffortValue } from 'src/models/effort/effort.js'
import type { NativeWebSearchRequest } from '../../../tools/engines/web-search/nativeSearchRequest.js'
import type { CallModelParams, CallModelStream } from '../callModelContract.js'
import type { ConnectorTextBlock } from './connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  SystemStreamCutMessage,
} from '../../../engine/message-shapes/message.js'
import type {
  ApiStreamEvent as BetaRawMessageStreamEvent,
  ApiToolUnion,
  ContentBlock as BetaContentBlock,
  JsonOutputFormat,
  StreamCapabilityAdvertisement,
} from '../../../engine/message-shapes/wire.js'
import { setLastApiCompletionTimestamp } from 'src/boot/process-state/processState.js'
import { logForDebugging } from 'src/platform/logs/debugLog.js'
import { logForDiagnosticsNoPII } from 'src/platform/logs/diagnosticsLog.js'
import { resetApiConnectionPool } from 'src/platform/network/proxy.js'
import { transportCutOf } from '../../../engine/request-parts/transportEvidence.js'
import { effortStampOf } from '../../effort/effortStamp.js'
import { isEnvTruthy } from '../../../platform/environment/envUtils.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import { fitImagesToRequestCap, manyImageLimitStatedIn } from '../../../platform/images/imageResizer.js'
import { captureAPIRequest } from '../../../platform/logs/errorLog.js'
import { processOwnerForLane } from '../../../engine/run-owner/resolveOwner.js'
import { startSessionActivity } from '../../../engine/requests/sessionActivity.js'
import { createAssistantAPIErrorMessage, createUserMessage } from '../../../engine/messages/messages.js'
import { toolToAPISchema } from '../../../engine/messages/apiSystemAndToolSchema.js'
import { utilityCallFor } from '../../catalogue/utilityModel.js'
import type { SystemPrompt } from '../../../engine/system-prompt/systemPromptType.js'
import { API_ERROR_MESSAGE_PREFIX, getErrorMessageIfRefusal, malformedStreamFrameText } from '../../../engine/requests/apiErrorRows.js'
import { EMPTY_USAGE } from '../../../engine/requests/apiCallLogging.js'
import { CannotRetryError, FallbackTriggeredError, is529Error, retryEmptyStream } from '../../../engine/requests/withRetry.js'
import { withStreamingFixtureReplay } from './fixtureReplay.js'
import type { HeldBusyRetryWait } from '../busyRetry.js'
import { emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { captureSignInRequest, observeSignInResponse } from '../signInRefusal.js'
import { toolCallRefusalNote } from '../toolCallGate.js'
import { planToolPayload } from '../toolEconomy.js'
import { safeParseJSON } from '../../../platform/storage/json.js'
import type { RefusedToolCall } from '../../../engine/message-shapes/message.js'
import type { RequestWaitV1 } from '../streamIdleBudget.js'
import { captureModelRefusalRequest, type ModelRefusalRequest } from './modelRefusal.js'
import { anthropicEffortWireFact } from './requestParams.js'
type BetaToolChoiceAuto = Extract<BetaMessageStreamParams['tool_choice'], { type: 'auto' }>
type BetaToolChoiceTool = Extract<BetaMessageStreamParams['tool_choice'], { type: 'tool' }>
type BetaToolChoiceNone = Extract<BetaMessageStreamParams['tool_choice'], { type: 'none' }>
import type { CallState, CallCtx, StreamPass } from './stream-core/callState.js'
import { createCallLedger } from './stream-core/callLedger.js'
import { executeNonStreamingRequest } from './stream-core/nonStreaming.js'
import { streamPassRetries, retryWaitOf } from './stream-core/passRetries.js'
import { preEventReissueRow, streamCutReissueRow, oneShotNoticeRow, oneShotAnswerOf, streamCreation404Row } from './stream-core/reissueRows.js'
import { failedRequestRows } from './stream-core/requestFailed.js'
import { messagesBeforeImages, requestBetas, toolRosterOf, wireRequestOf } from './stream-core/requestPlan.js'
import { closeSucceededRequest, settleAttemptLedger } from './stream-core/settleCall.js'
import { openStreamPass, resetStreamAttempt, noteStreamEvent, startMessage, openContentBlock, applyBlockDelta, settleMessageDelta, noteWatchdogCleanExit, observeStreamEnd, noteWatchdogErrorExit, sdkAbortError } from './stream-core/streamEvents.js'
import { watchStream } from './stream-core/watchStream.js'
import { wireParamsFor } from './stream-core/wireParams.js'
import { asSystemPrompt } from '../../../engine/system-prompt/systemPromptType.js'
import { withFixtureReplay } from './fixtureReplay.js'

export const ANTHROPIC_STREAM_ADVERTISEMENT: StreamCapabilityAdvertisement = {
  textDelta: true,
  reasoningDelta: true,
  toolArgsDelta: true,
  usage: true,
  timing: true,
}

export type Options = {
  querySource: QuerySource
  isNonInteractiveSession: boolean
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  mcpTools: Tools
  hasAppendSystemPrompt: boolean
  ownerKey?: string
  agentId?: AgentId
  callChain?: ToolCallChain
  allowedAgentTypes?: string[]
  hasPendingMcpServers?: boolean
  model: string
  fallbackModel?: string
  effortValue?: EffortValue
  effortPinned?: boolean
  ridesSessionEffort?: boolean
  maxOutputTokensOverride?: number
  temperatureOverride?: number
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  outputFormat?: JsonOutputFormat
  toolChoice?: BetaToolChoiceAuto | BetaToolChoiceTool | BetaToolChoiceNone
  extraToolSchemas?: ApiToolUnion[]
  nativeWebSearch?: NativeWebSearchRequest
  onWait?: (wait: RequestWaitV1 | null) => void
  onStreamActivity?: (atMs: number) => void
  onStreamingFallback?: () => void
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

export async function anthropicCallModelSettled(
  request: CallModelParams,
): Promise<AssistantMessage> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = request
  const settled: AssistantMessage[] = []
  const stream = withStreamingFixtureReplay(messages, () =>
    callCore(messages, systemPrompt, thinkingConfig, tools, signal, options),
  )
  for await (const item of stream) {
    if (item.type === 'assistant') settled.push(item)
  }
  const last = settled.at(-1)
  if (last) return last
  throw signal.aborted ? new APIUserAbortError() : new Error('No assistant message found')
}

export async function* anthropicCallModel({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: CallModelParams): CallModelStream {
  return yield* withStreamingFixtureReplay(messages, () =>
    callCore(messages, systemPrompt, thinkingConfig, tools, signal, options),
  )
}

const NO_EVENTS_MESSAGE = 'Stream ended without receiving any events'
const EMPTY_CLOSE_DETAIL = 'closed with no events'

function watchdogFired(pass: StreamPass): pass is StreamPass & { streamWatchdogFiredAt: number } {
  return pass.streamWatchdogFiredAt !== null
}

function spokenByProvider(error: unknown): boolean {
  return error instanceof APIError && !(error instanceof APIConnectionError)
}

export { executeNonStreamingRequest } from './stream-core/nonStreaming.js'

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

async function prepareCall(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): Promise<{ call: CallState; ctx: CallCtx; resolvedModel: string }> {
  const effortContext = { agentId: options.agentId, pinned: options.effortPinned === true }
  const effortTruth = resolveEffortTruth(options.model, options.effortValue, effortContext)
  const effortRides = options.effortPinned === true || options.ridesSessionEffort !== false
  const initialEffortOnWire = effortStampOf(
    effortRides ? effortTruth.requested : undefined,
    effortTruth.supportsEffort ? { kind: 'omitted' } : { kind: 'unsupported' },
  )
  const call: CallState = {
    signInRequest: undefined,
    effortOnWire: initialEffortOnWire,
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
  const resolvedModel = options.model
  const modelRefusalRequest: { current?: ModelRefusalRequest } = {}
  const captureModelRequest = (params: BetaMessageStreamParams): void => {
    modelRefusalRequest.current = captureModelRefusalRequest(params.model)
    const wireOutputConfig = params.output_config
      ? { effort: params.output_config.effort ?? undefined }
      : undefined
    call.effortOnWire = effortStampOf(
      effortRides ? effortTruth.requested : undefined,
      anthropicEffortWireFact({ output_config: wireOutputConfig }, effortTruth.supportsEffort),
    )
    call.signInRequest = captureSignInRequest('anthropic')
    captureAPIRequest(params, options.querySource)
  }

  const betas = requestBetas(options)
  const rosterOwnerKey = options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null))
  const toolPlan = await planToolPayload({
    model: options.model,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
    latchKey: rosterOwnerKey,
  })
  const { useToolSearch, blockForm, filteredTools, willDefer } = toolRosterOf(
    toolPlan,
    betas,
    tools,
    options,
    rosterOwnerKey,
  )
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: filteredTools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
        bound: toolPlan.isBound(tool.name),
        conversationKey: toolPlan.conversationKey,
      }),
    ),
  )

  const preparedMessages = messagesBeforeImages(
    messages,
    filteredTools,
    useToolSearch,
    blockForm,
    rosterOwnerKey,
  )
  const statedSidePx = manyImageLimitStatedIn(messages)
  const fittedImages = await fitImagesToRequestCap(preparedMessages, {
    owner: rosterOwnerKey,
    model: options.model,
    ...(statedSidePx !== null ? { statedSidePx } : {}),
  })
  const planned = wireRequestOf(
    fittedImages,
    messages,
    systemPrompt,
    thinkingConfig,
    options,
    rosterOwnerKey,
    toolSchemas,
  )

  const appliedEffort = effortRides
    ? resolveAppliedEffort(options.model, options.effortValue, effortContext)
    : undefined
  const startIncludingRetries = Date.now()
  const paramsFromContext = wireParamsFor(call, {
    messages,
    thinkingConfig,
    options,
    betas,
    rosterOwnerKey,
    planned,
    effort: appliedEffort,
  })

  const newMessages: AssistantMessage[] = []
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  const stoppedBlockIndices = new Set<number>()
  const ledger = createCallLedger(
    call,
    tools,
    options,
    resolvedModel,
    newMessages,
    contentBlocks,
    stoppedBlockIndices,
    observeSignInResponse,
  )
  const heldWaitDoor: ((wait: HeldBusyRetryWait) => void) | undefined =
    options.agentId !== undefined && options.onWait !== undefined
      ? wait => options.onWait?.(wait)
      : undefined

  const ctx: CallCtx = {
    ...ledger,
    messages,
    thinkingConfig,
    signal,
    options,
    modelRefusalRequest,
    captureModelRequest,
    observeSignInResponse,
    rosterOwnerKey,
    prefixKey: planned.prefixKey,
    turnOwning: planned.turnOwning,
    messagesForAPI: planned.messagesForAPI,
    startIncludingRetries,
    paramsFromContext,
    heldWaitDoor,
    newMessages,
    contentBlocks,
    stoppedBlockIndices,
  }
  return { call, ctx, resolvedModel }
}

function* streamOneEvent(
  ctx: CallCtx,
  call: CallState,
  pass: StreamPass,
  part: BetaRawMessageStreamEvent,
): Generator<StreamEvent | AssistantMessage, void> {
  switch (part.type) {
    case 'message_start':
      startMessage(call, part, ctx.noteServedModel)
      break
    case 'content_block_start':
      openContentBlock(ctx.contentBlocks, part)
      break
    case 'content_block_delta':
      applyBlockDelta(ctx.contentBlocks, part)
      break
    case 'content_block_stop': {
      const block = ctx.contentBlocks[part.index]
      if (!block) {
        throw new RangeError('Content block not found')
      }
      if (!call.partialMessage) {
        throw new Error('Message not found')
      }
      const cutCall = cutToolCallOf(block)
      if (cutCall !== null) {
        const refusedMessage = ctx.mintAssistantMessage(call.partialMessage, [
          {
            type: 'text',
            text: toolCallRefusalNote('anthropic', cutCall),
            citations: null,
          },
        ])
        refusedMessage.refusedToolCalls = [cutCall]
        ctx.stoppedBlockIndices.add(part.index)
        ctx.newMessages.push(refusedMessage)
        yield refusedMessage
      } else {
        const message = ctx.mintAssistantMessage(call.partialMessage, [block])
        ctx.stoppedBlockIndices.add(part.index)
        if (block.type === 'tool_use') {
          pass.streamedToolUse = true
        }
        ctx.newMessages.push(message)
        yield message
      }
      break
    }
    case 'message_delta': {
      if (!part.delta) {
        throw new Error(malformedStreamFrameText('message_delta', 'delta'))
      }
      settleMessageDelta(call, part, ctx.newMessages, ctx.pricingModel, ctx.options, ctx.messages)
      const refusalRow = getErrorMessageIfRefusal(
        part.delta.stop_reason,
        ctx.pricingModel(),
        { requestId: call.streamRequestId, raw: part.delta },
      )
      if (refusalRow) {
        refusalRow.effort = call.effortOnWire
        yield refusalRow
      }
      if (part.delta.stop_reason === 'max_tokens') {
        const maxTokensError = createAssistantAPIErrorMessage({
          content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response exceeded the ${call.maxOutputTokens} output token maximum. To configure this behavior, set the MERCURY_MAX_OUTPUT_TOKENS environment variable.`,
          apiError: 'max_output_tokens',
          error: 'max_output_tokens',
        })
        maxTokensError.effort = call.effortOnWire
        yield maxTokensError
      } else if (part.delta.stop_reason === 'model_context_window_exceeded') {
        const contextError = createAssistantAPIErrorMessage({
          content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response stopped at the model's context window limit.`,
          apiError: 'max_output_tokens',
          error: 'max_output_tokens',
        })
        contextError.effort = call.effortOnWire
        yield contextError
      }
      break
    }
    case 'message_stop':
      pass.sawMessageStop = true
      break
  }

  yield {
    type: 'stream_event',
    event: part,
    ...(part.type === 'message_start' ? { ttftMs: call.ttftMs } : {}),
  }
}

async function* runStreamPass(
  ctx: CallCtx,
  call: CallState,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage | SystemStreamCutMessage,
  'continue' | 'done' | 'abort'
> {
  const pass = openStreamPass()
  const retryGen = streamPassRetries(call, pass, ctx)
  let retryStep = await retryGen.next()
  while (!retryStep.done) {
    const notice = retryStep.value
    if (notice.type === 'system' && notice.subtype === 'api_error') {
      ctx.options.onWait?.(retryWaitOf(notice))
    }
    yield notice
    retryStep = await retryGen.next()
  }
  const stream = retryStep.value
  call.stream = stream

  resetStreamAttempt(
    call,
    ctx.settleUnpricedAttempt,
    ctx.newMessages,
    ctx.contentBlocks,
    ctx.stoppedBlockIndices,
  )
  const watch = watchStream(ctx, call, pass)
  startSessionActivity('api_call')

  try {
    try {
      for await (const part of stream) {
        noteStreamEvent(pass, watch.streamIdleWatchdog, watch.activityRelay, ctx.options)
        yield* streamOneEvent(ctx, call, pass, part)
        if (pass.sawMessageStop) {
          setLastApiCompletionTimestamp(Date.now())
          break
        }
      }
      watch.clearIdleTimers()

      if (ctx.signal.aborted) {
        yield* ctx.yieldAbortedPartialText()
        ctx.releaseStreamResources()
        return 'abort'
      }

      if (pass.streamIdleAborted) {
        noteWatchdogCleanExit(pass)
        if (watch.settledTailStands()) {
          yield* watch.settleTypedEnd({
            reason: 'silent-after-last-item',
            provider: 'Anthropic',
            silentMs: watch.streamIdleWatchdog.fired()?.silentMs ?? watch.STREAM_IDLE_TIMEOUT_MS,
          })
        } else {
          throw new Error('Stream idle timeout - no chunks received')
        }
      }

      if (!call.partialMessage || (ctx.newMessages.length === 0 && call.stopReason === null)) {
        logForDebugging(
          !call.partialMessage
            ? 'stream closed before message_start'
            : 'stream closed after message_start with no completed block and no stop_reason — routing to the non-streaming fallback',
          { level: 'error' },
        )
        throw new Error(NO_EVENTS_MESSAGE)
      }

      if (call.stopReason === null) {
        if (watch.settledTailStands()) {
          yield* watch.settleTypedEnd({ reason: 'closed-after-last-item', provider: 'Anthropic' })
        } else if (watch.settledToolUseTailStands()) {
          yield* watch.settleTypedEnd(
            { reason: 'closed-after-last-item', provider: 'Anthropic' },
            'tool_use',
          )
        } else {
          logForDebugging(
            'stream closed with no stop_reason and a block still open, or a settled tail that is neither text nor a tool call — routing to the non-streaming fallback',
            { level: 'error' },
          )
          throw new Error(NO_EVENTS_MESSAGE)
        }
      }

      observeStreamEnd(call, pass, ctx.turnOwning, ctx.prefixKey)
      return 'done'
    } catch (streamingError) {
      watch.clearIdleTimers()
      if (watchdogFired(pass)) {
        noteWatchdogErrorExit(pass)
      }
      if (pass.streamIdleAborted && !ctx.signal.aborted && watch.settledTailStands()) {
        yield* watch.settleTypedEnd({
          reason: 'silent-after-last-item',
          provider: 'Anthropic',
          silentMs: watch.streamIdleWatchdog.fired()?.silentMs ?? watch.STREAM_IDLE_TIMEOUT_MS,
        })
        return 'done'
      }
      if (streamingError instanceof APIUserAbortError) {
        throw sdkAbortError(ctx.signal, streamingError)
      }
      const cut = transportCutOf(streamingError)

      if (
        !pass.sawFirstStreamEvent &&
        !pass.streamIdleAborted &&
        !ctx.signal.aborted &&
        !spokenByProvider(streamingError)
      ) {
        const detail =
          cut?.code ??
          (streamingError instanceof Error && streamingError.message === NO_EVENTS_MESSAGE
            ? EMPTY_CLOSE_DETAIL
            : errorMessage(streamingError))
        const emptyOutcome = yield* retryEmptyStream(call, {
          provider: 'Anthropic',
          detail,
          cause: streamingError,
          log: '',
          signal: ctx.signal,
          whilePaused: resetApiConnectionPool,
          ...(ctx.options.onWait !== undefined ? { onWait: ctx.options.onWait } : {}),
        })
        if (emptyOutcome === 'cancelled') {
          throw new APIUserAbortError()
        }
        if (emptyOutcome === 'again') {
          return 'continue'
        }
        const spent = emptyStreamSpentWords('Anthropic', Date.now() - ctx.startIncludingRetries)
        logForDebugging(`${spent} (${detail})`, { level: 'error' })
        throw new Error(`${spent} — ${detail}; try again shortly`)
      }

      if (
        isEnvTruthy(flagEnv('MERCURY_DISABLE_NONSTREAMING_FALLBACK')) ||
        (pass.streamIdleAborted && pass.streamedToolUse)
      ) {
        logForDebugging(
          `The stream failed and the one-shot retry is off: ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      }

      if (pass.streamIdleAborted && !pass.sawFirstStreamEvent && !call.preFirstEventStreamRetryUsed) {
        yield preEventReissueRow(
          call,
          streamingError,
          watch.preEventSilenceWords,
          watch.STREAM_IDLE_TIMEOUT_MS,
        )
        return 'continue'
      }

      if (cut !== null && !ctx.signal.aborted && !pass.streamedToolUse && !call.streamCutRetryUsed) {
        yield streamCutReissueRow(call, ctx.options, cut)
        return 'continue'
      }

      yield oneShotNoticeRow(
        call,
        pass,
        ctx.options,
        streamingError,
        cut,
        watch.STREAM_IDLE_TIMEOUT_MS,
        watch.streamIdleWatchdog,
        watch.preEventSilenceWords,
      )
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')

      const fallbackResult = yield* executeNonStreamingRequest(
        {
          model: ctx.options.model,
          fetchOverride: ctx.options.fetchOverride,
          source: ctx.options.querySource,
        },
        {
          model: ctx.options.model,
          fallbackModel: ctx.options.fallbackModel,
          thinkingConfig: ctx.thinkingConfig,
          signal: ctx.signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0,
          querySource: ctx.options.querySource,
          ...(ctx.heldWaitDoor !== undefined ? { onHeldWait: ctx.heldWaitDoor } : {}),
        },
        ctx.paramsFromContext,
        (_attempt, start, maxOutputTokens) => {
          call.start = start
          call.maxOutputTokens = maxOutputTokens
        },
        ctx.captureModelRequest,
        call.streamRequestId,
        pass.streamIdleAborted
          ? {
              idleMs: watch.streamIdleWatchdog.fired()?.silentMs ?? watch.STREAM_IDLE_TIMEOUT_MS,
              model: watch.modelDisplayName,
            }
          : undefined,
      )
      yield oneShotAnswerOf(
        call,
        fallbackResult,
        ctx.noteServedModel,
        ctx.mintAssistantMessage,
        ctx.newMessages,
        ctx.options,
        ctx.rosterOwnerKey,
      )
      return 'done'
    }
  } finally {
    watch.clearIdleTimers()
  }
}

async function* callCore(
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
  const { call, ctx } = await prepareCall(
    messages,
    systemPrompt,
    thinkingConfig,
    tools,
    signal,
    options,
  )

  let succeeded = false
  try {
    while (true) {
      const outcome = yield* runStreamPass(ctx, call)
      if (outcome === 'abort') return
      if (outcome === 'done') break
    }
    call.settledNormally = true
    succeeded = true
  } catch (error) {
    if (error instanceof FallbackTriggeredError) {
      throw error
    }
    if (
      error instanceof CannotRetryError &&
      error.originalError instanceof APIError &&
      error.originalError.status === 404 &&
      !call.didFallBackToNonStreaming
    ) {
      const originalError = error.originalError
      yield streamCreation404Row(call, options, originalError)
      try {
        const fallbackResult = yield* executeNonStreamingRequest(
          {
            model: options.model,
            fetchOverride: options.fetchOverride,
            source: options.querySource,
          },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            signal,
            ...(ctx.heldWaitDoor !== undefined ? { onHeldWait: ctx.heldWaitDoor } : {}),
          },
          ctx.paramsFromContext,
          (_attempt, start, maxOutputTokens) => {
            call.start = start
            call.maxOutputTokens = maxOutputTokens
          },
          ctx.captureModelRequest,
          originalError.requestID ?? 'unknown',
        )
        yield oneShotAnswerOf(
          call,
          fallbackResult,
          ctx.noteServedModel,
          ctx.mintAssistantMessage,
          ctx.newMessages,
          options,
          ctx.rosterOwnerKey,
        )
        call.settledNormally = true
        succeeded = true
      } catch (fallbackError) {
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }
        logForDebugging(`The one-shot retry failed too: ${errorMessage(fallbackError)}`, {
          level: 'error',
        })
        yield* failedRequestRows(ctx, fallbackError)
        ctx.releaseStreamResources()
        return
      }
    } else {
      logForDebugging(`Error in API request: ${errorMessage(error)}`, { level: 'error' })
      yield* failedRequestRows(ctx, error)
      ctx.releaseStreamResources()
      return
    }
  } finally {
    settleAttemptLedger(ctx, call)
  }

  if (succeeded) {
    closeSucceededRequest(ctx, call)
  }
}

type UtilityOptions = Omit<
  Options,
  'model' | 'getToolPermissionContext' | 'effortValue' | 'effortPinned' | 'ridesSessionEffort'
>

export async function callUtilityModel({
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
  const { thinkingConfig, ...utilityOptions } = utilityCallFor()
  return callWithModel({
    systemPrompt,
    userPrompt,
    outputFormat,
    signal,
    thinkingConfig,
    options: {
      ...options,
      ...utilityOptions,
      effortPinned: true,
    },
  })
}

type CallWithModelOptions = Omit<Options, 'getToolPermissionContext'>

type OneShotQuestion = {
  systemPrompt: SystemPrompt; userPrompt: string; outputFormat?: JsonOutputFormat
  signal: AbortSignal; options: CallWithModelOptions; thinkingConfig?: ThinkingConfig
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

export async function callWithModel(question: OneShotQuestion): Promise<AssistantMessage> {
  const { systemPrompt = asSystemPrompt([]), userPrompt, outputFormat, signal, options, thinkingConfig } = question
  question = { systemPrompt, userPrompt, outputFormat, signal, options, thinkingConfig }
  const { routedCallModel, settleAssistantTurn } = await import('../callModelRouter.js')
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
  const [reply] = await withFixtureReplay(recordedInput, answer)
  return reply! as AssistantMessage
}

export { MAX_NON_STREAMING_TOKENS, adjustParamsForNonStreaming } from './stream-core/nonStreaming.js'

export { getMaxOutputTokensForModel } from './stream-core/wireParams.js'
