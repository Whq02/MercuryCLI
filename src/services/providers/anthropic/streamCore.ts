
import { flagEnv } from '../../../substrate/flagRegistry.js'
import type { AnthropicClientOptions as ClientOptions } from './anthropicClient.js'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '../../api/sdkErrors.js'
import type { ContentBlock as BetaContentBlock } from '../../../types/wire.js'
import type { AnthropicMessageParams as BetaMessageStreamParams } from './anthropicWire.js'
import type { AnthropicStream } from './anthropicStream.js'
import { randomUUID } from 'crypto'
import {
  getCacheEditingHeaderLatched,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import type { AgentId } from 'src/types/ids.js'
import type { NativeWebSearchRequest } from 'src/services/search/nativeSearchRequest.js'
import { cacheClockObserve } from 'src/utils/cache/cacheClock.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { EffortValue } from 'src/utils/effort.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { noteRunPhase } from 'src/utils/runPhases.js'
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
import { noteRequestOnWire } from './prefixLedger.js'
import { noteCacheDiagnostics } from './cacheDiagnostics.js'
import type {
  ConnectorTextBlock,
  ConnectorTextDelta,
} from '../../../types/connectorText.js'
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
import { isTurnOwningQuerySource, resolveAppliedEffort, resolveEffortTruth } from '../../../utils/effort.js'
import { effortStampOf } from '../../../utils/effortStamp.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { errorMessage } from '../../../utils/errors.js'
import { fitImagesToRequestCap, manyImageLimitStatedIn } from '../../../utils/imageResizer.js'
import { captureAPIRequest } from '../../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createStreamCutMessage,
  createSystemAPIErrorMessage,
  createUserMessage,
} from '../../../utils/messages.js'
import { processOwnerForLane } from '../../run/resolveOwner.js'
import { getPublicModelDisplayName } from '../../../utils/model/model.js'
import { utilityCallFor } from '../../../utils/model/utilityModel.js'
import { startSessionActivity } from '../../../utils/sessionActivity.js'
import { settleTranscriptMessage } from '../../../utils/sessionStorage/writer.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../../utils/systemPromptType.js'
import {
  anthropicLimitVerdict,
  clearAnthropicUsageLimit,
  extractQuotaStatusFromHeaders,
} from '../../anthropicLimits.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
} from '../../compact/microCompact.js'
import { refreshProviderUsage } from '../providerUsage.js'
import { withStreamingVCR, withVCR } from '../../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from '../../api/client.js'
import { transportCutOf, transportCutWords } from '../../api/transportEvidence.js'
import { captureModelRefusalRequest, type ModelRefusalRequest } from './modelRefusal.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
  malformedStreamFrameText,
} from '../../api/errors.js'
import { EMPTY_USAGE } from '../../api/logging.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  type NeutralSystemBlock,
  type NeutralToolSchema,
} from '../../api/promptCacheBreakDetection.js'
import type { ModelCallReference } from '../../../run-core/call-reference.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  withRetry,
} from '../../api/withRetry.js'
import type { HeldBusyRetryWait } from '../busyRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords } from '../emptyStreamRetry.js'
import { retrySeconds } from '../../api/recoveryBudget.js'
import { toolCallRefusalNote } from '../toolCallGate.js'
import { safeParseJSON } from '../../../utils/json.js'
import type { RefusedToolCall } from '../../../types/message.js'
import { sleep } from '../../../utils/sleep.js'
import { updateUsage } from './cacheAndUsage.js'
import {
  coldPrefixOf,
  estimateRequestTokens,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  retryNoticeWait,
  retryReasonWords,
  streamActivityFetchOptions,
  streamIdleTimeoutMsForRoute,
  type RequestWaitV1,
} from '../streamIdleBudget.js'
import { patienceSeconds } from '../patience.js'
import { anthropicEffortWireFact } from './requestParams.js'
type BetaToolChoiceAuto = Extract<BetaMessageStreamParams['tool_choice'], { type: 'auto' }>
type BetaToolChoiceTool = Extract<BetaMessageStreamParams['tool_choice'], { type: 'tool' }>
type BetaToolChoiceNone = Extract<BetaMessageStreamParams['tool_choice'], { type: 'none' }>
import type { CallState, QueryCtx, StreamPass } from './streamCore/state.js'
import { createCallLedger } from './streamCore/callLedger.js'
import { executeNonStreamingRequest, getNonstreamingFallbackTimeoutMs, isFirstByteTimeout } from './streamCore/nonStreaming.js'
import { messagesBeforeImages, requestBetas, toolRosterOf, wireRequestOf } from './streamCore/requestPlan.js'
import { closeSucceededRequest, settleAttemptLedger } from './streamCore/settleCall.js'
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
  const { releaseStreamResources, noteServedModel, pricingModel, mintAssistantMessage, yieldAbortedPartialText, settleUnpricedAttempt, logRequestFailure } = ledger

  const heldWaitDoor = options.agentId !== undefined ? (wait: HeldBusyRetryWait): void => options.onWait?.(wait) : undefined
  const ctx: QueryCtx = { options, modelRefusalRequest, observeSignInResponse, startIncludingRetries, newMessages, contentBlocks, stoppedBlockIndices, ...ledger }
  try {
    streamingPass: for (;;) {
    const firstByte: { wait: Extract<RequestWaitV1, { kind: 'first-byte' }> | null } = { wait: null }
    const pass: StreamPass = {
      noteTransportActivity: null,
      transportSawByte: false,
      firstByte,
      streamIdleAborted: false,
      streamedToolUse: false,
      sawFirstStreamEvent: false,
      streamEventCount: 0,
      streamWatchdogFiredAt: null,
      sawMessageStop: false,
    }
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        if (attempt > 1 || anthropicLimitVerdict().status === 'rejected') await refreshProviderUsage('anthropic', { force: true, reason: 'operator' })
        call.start = Date.now()

        const params = paramsFromContext(context)
        captureModelRequest(params)

        recordPromptState({
          system: params.system as unknown as NeutralSystemBlock[],
          toolSchemas: params.tools as unknown as NeutralToolSchema[],
          querySource: options.querySource,
          model: options.model,
          agentId: options.agentId,
          betas: params.betas ?? [],
          effortValue: params.output_config?.effort as string | undefined,
          lane: 'anthropic',
          callReference: options.callReference,
        })

        call.maxOutputTokens = params.max_tokens

        const promptTokens = estimateRequestTokens({ system: params.system, tools: params.tools, messages: params.messages })
        const cold = coldPrefixOf(messages, options.model)
        const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
          kind: 'first-byte',
          cold,
          promptTokens,
          model: getPublicModelDisplayName(context.model) ?? context.model,
          budgetMs: firstByteBudgetMs({ cold, promptTokens, idleMs: streamIdleTimeoutMsForRoute('anthropic') }),
          sinceMs: Date.now(),
          attempt,
        }
        firstByte.wait = wait
        pass.transportSawByte = false
        options.onWait?.(wait)

        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
          noteRunPhase('dispatch')
        }

        call.clientRequestId = isFirstPartyAnthropicBaseUrl() ? randomUUID() : undefined

        const dispatch = () =>
          anthropic.beta.messages
            .create(
              { ...params, stream: true },
              {
                signal,
                timeout: wait.budgetMs,
                fetchOptions: streamActivityFetchOptions(() => {
                  pass.transportSawByte = true
                  pass.noteTransportActivity?.()
                }) as never,
                ...(call.clientRequestId && {
                  headers: { [CLIENT_REQUEST_ID_HEADER]: call.clientRequestId },
                }),
              },
            )
            .withResponse()
        let result: Awaited<ReturnType<typeof dispatch>>
        try {
          result = await dispatch()
        } catch (sent) {
          if (!signal.aborted && isFirstByteTimeout(sent)) {
            logForDebugging(`first-byte budget fired: ${firstByteTimeoutLine(wait)}`, { level: 'warn' })
            throw new APIConnectionTimeoutError({ message: firstByteTimeoutLine(wait), requestDeadline: (sent as { requestDeadline?: unknown }).requestDeadline === true })
          }
          throw sent
        }
        options.onWait?.(null)
        call.streamRequestId = result.request_id
        call.streamResponse = result.response
        if (isTurnOwningQuerySource(options.querySource)) noteRequestOnWire(rosterOwnerKey)
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        signal,
        querySource: options.querySource,
        ...(heldWaitDoor !== undefined ? { onHeldWait: heldWaitDoor } : {}),
        healClientContract: true,
      },
    )

    let e
    do {
      e = await generator.next()
      if (!('controller' in e.value)) {
        const notice = e.value as SystemAPIErrorMessage
        if (notice.type === 'system' && notice.subtype === 'api_error') {
          const retryWait: RequestWaitV1 = {
            kind: 'retry',
            attempt: notice.retryAttempt,
            of: notice.maxRetries,
            reason: retryReasonWords(notice.errorDetail?.status ?? (notice.error as { status?: number | null } | undefined)?.status, notice.error?.message),
            delayMs: notice.retryInMs,
            sinceMs: Date.now(),
          }
          options.onWait?.(retryWait)
        }
        yield e.value
      }
    } while (!e.done)
    call.stream = e.value as AnthropicStream

    settleUnpricedAttempt()
    newMessages.length = 0
    call.ttftMs = 0
    call.partialMessage = undefined
    contentBlocks.length = 0
    stoppedBlockIndices.clear()
    call.usage = EMPTY_USAGE
    call.stopReason = null
    call.ledgerSettled = false
    const { STREAM_IDLE_TIMEOUT_MS, modelWords, preEventSilenceWords, streamIdleWatchdog, activityRelay, clearStreamIdleTimers, settledTailType, settledTailStands, settleTypedEnd } = watchStream(ctx, call, pass)

    startSessionActivity('api_call')
    try {
      let isFirstChunk = true
      let lastEventTime: number | null = null
      const STALL_THRESHOLD_MS = 30_000
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of call.stream) {
        streamIdleWatchdog.noteActivity()
        activityRelay.noteEvent()
        pass.sawFirstStreamEvent = true
        pass.streamEventCount++
        const now = Date.now()

        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `stream stalled ${(timeSinceLastEvent / 1000).toFixed(1)}s between events (stall #${stallCount})`,
              { level: 'warn' },
            )
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          logForDebugging('stream live — first chunk received')
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
            noteRunPhase('first_byte')
          }
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            call.partialMessage = part.message
            call.ttftMs = Date.now() - call.start
            call.usage = updateUsage(call.usage, part.message?.usage)
            noteServedModel(part.message?.model)
            noteCacheDiagnostics(part.message, part.message?.usage, call.ledgerFirstDifference)
            break
          }
          case 'content_block_start':
            if (part.content_block == null) {
              throw new Error(malformedStreamFrameText('content_block_start', 'content_block'))
            }
            switch (part.content_block.type) {
              case 'tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                break
              case 'server_tool_use':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                break
              case 'text':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  thinking: '',
                  signature: '',
                }
                break
              default:
                contentBlocks[part.index] = { ...part.content_block }
                break
            }
            break
          case 'content_block_delta': {
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              throw new RangeError('Content block not found')
            }
            if (delta == null) {
              throw new Error(malformedStreamFrameText('content_block_delta', 'delta'))
            }
            switch (delta.type) {
              case 'citations_delta':
                break
              case 'input_json_delta':
                if (
                  contentBlock.type !== 'tool_use' &&
                  contentBlock.type !== 'server_tool_use'
                ) {
                  throw new Error('Content block is not a input_json block')
                }
                if (typeof contentBlock.input !== 'string') {
                  throw new Error('Content block input is not a string')
                }
                contentBlock.input += delta.partial_json
                break
              case 'text_delta':
                if (contentBlock.type !== 'text') {
                  throw new Error('Content block is not a text block')
                }
                contentBlock.text += delta.text
                break
              case 'signature_delta':
                if (contentBlock.type !== 'thinking') {
                  throw new Error('Content block is not a thinking block')
                }
                contentBlock.signature = delta.signature
                break
              case 'thinking_delta':
                if (contentBlock.type !== 'thinking') {
                  throw new Error('Content block is not a thinking block')
                }
                contentBlock.thinking += delta.thinking
                break
            }
            break
          }
          case 'content_block_stop': {
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
              yield note
              break
            }
            const m = mintAssistantMessage(call.partialMessage, [
              contentBlock,
            ] as BetaContentBlock[])
            stoppedBlockIndices.add(part.index)
            if (contentBlock.type === 'tool_use') {
              pass.streamedToolUse = true
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            if (part.delta == null) {
              throw new Error(malformedStreamFrameText('message_delta', 'delta'))
            }
            call.usage = updateUsage(call.usage, part.usage)

            call.stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = call.usage as AssistantMessage['message']['usage']
              lastMsg.message.stop_reason = call.stopReason
              void settleTranscriptMessage(lastMsg)
            }

            const costUSDForPart = calculateUSDCost(pricingModel(), call.usage)
            addToTotalSessionCost(costUSDForPart, call.usage, pricingModel())
            call.ledgerSettled = true

            void checkResponseForCacheBreak(
              options.querySource,
              call.usage.cache_read_input_tokens,
              call.usage.cache_creation_input_tokens,
              messages,
              options.agentId,
              call.clientRequestId ?? null,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
              { requestId: call.clientRequestId ?? null, raw: part.delta },
            )
            if (refusalMessage) {
              yield { ...refusalMessage, effort: call.effortOnWire }
            }

            if (call.stopReason === 'max_tokens') {
              yield {
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

            if (call.stopReason === 'model_context_window_exceeded') {
              yield {
                ...createAssistantAPIErrorMessage({
                  content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response stopped at the model's context window limit.`,
                  apiError: 'max_output_tokens',
                  error: 'max_output_tokens',
                }),
                effort: call.effortOnWire,
              }
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
        const exitDelayMs =
          pass.streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - pass.streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logForDebugging(
          `stream loop exited ${exitDelayMs}ms after watchdog abort (clean exit)`,
        )
        pass.streamWatchdogFiredAt = null
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

      if (stallCount > 0) {
        logForDebugging(
          `stream finished carrying ${stallCount} stall(s), ${(totalStallTime / 1000).toFixed(1)}s stalled in total`,
          { level: 'warn' },
        )
      }

      cacheClockObserve({
        cacheReadTokens: call.usage.cache_read_input_tokens,
        cacheCreationTotal: call.usage.cache_creation_input_tokens,
        cacheCreation5m: call.usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
        cacheCreation1h: call.usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
        uncachedInputTokens: call.usage.input_tokens,
        now: Date.now(),
        prefixKey: turnOwning ? prefixKey : null,
        startedAt: call.start,
      })

      const resp = call.streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers, call.start)
        clearAnthropicUsageLimit(call.start)
      }
    } catch (streamingError) {
      clearStreamIdleTimers()

      if (pass.streamIdleAborted && pass.streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - pass.streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logForDebugging(
          `stream loop exited ${exitDelayMs}ms after watchdog abort (error exit)`,
        )
      }

      if (pass.streamIdleAborted && !signal.aborted && settledTailStands()) {
        yield* settleTypedEnd({
          reason: 'silent-after-last-item',
          provider: 'Anthropic',
          silentMs: streamIdleWatchdog.fired()?.silentMs ?? STREAM_IDLE_TIMEOUT_MS,
        })
        break
      }

      if (streamingError instanceof APIUserAbortError) {
        if (signal.aborted) {
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          throw streamingError
        } else {
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      if (!pass.sawFirstStreamEvent && !pass.streamIdleAborted && !signal.aborted && !spokenByProvider(streamingError)) {
        call.emptyStreamEnds++
        const cutBeforeEvents = transportCutOf(streamingError)
        const detail = cutBeforeEvents !== null ? cutBeforeEvents.code : errorMessage(streamingError) === NO_EVENTS_MESSAGE ? EMPTY_CLOSE_DETAIL : errorMessage(streamingError)
        if (call.emptyStreamEnds < EMPTY_STREAM_TRIES) {
          resetApiConnectionPool()
          const waitMs = emptyStreamRetryWaitMs()
          const notice = emptyStreamRetryNotice({ provider: 'Anthropic', detail, cause: streamingError, attempt: call.emptyStreamEnds + 1, waitMs })
          logForDebugging(`${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${call.emptyStreamEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
          yield notice
          options.onWait?.(retryNoticeWait(notice))
          await sleep(waitMs, signal)
          if (signal.aborted) throw new APIUserAbortError()
          continue streamingPass
        }
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
        call.preFirstEventStreamRetryUsed = true
        resetApiConnectionPool()
        logForDiagnosticsNoPII('info', 'cli_stream_preevent_streaming_retry')
        logForDebugging(
          `watchdog: ${preEventSilenceWords()} — reissuing the stream (pass 2)`,
          { level: 'warn' },
        )
        yield createSystemAPIErrorMessage(
          Object.assign(
            new Error(
              `${preEventSilenceWords()}; reissuing the stream`,
            ),
            { cause: streamingError },
          ),
          0,
          1,
          2,
          { recoveryTimeoutMs: STREAM_IDLE_TIMEOUT_MS },
        )
        continue streamingPass
      }

      const cut = signal.aborted ? null : transportCutOf(streamingError)
      if (cut !== null && !pass.streamedToolUse && !call.streamCutRetryUsed) {
        call.streamCutRetryUsed = true
        resetApiConnectionPool()
        if (options.onStreamingFallback) {
          options.onStreamingFallback()
        }
        logForDiagnosticsNoPII('warn', 'cli_stream_cut_streaming_retry')
        logForDebugging(
          `${transportCutWords('Anthropic', cut)} — reissuing the stream on a fresh connection (pass 2)`,
          { level: 'warn' },
        )
        yield createStreamCutMessage({
          count: 1,
          content: `${transportCutWords('Anthropic', cut)}; the request was sent again on a fresh connection (reissue 1 of 1)`,
          road: 'Anthropic',
          sent: cut.words,
          code: cut.code,
        })
        continue streamingPass
      }

      logForDebugging(
        `The stream failed; the request is retried as one shot: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      if (pass.streamIdleAborted) resetApiConnectionPool()
      if (cut !== null) resetApiConnectionPool()
      call.didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }
      const fallbackWaitWords = `waiting up to ${patienceSeconds(getNonstreamingFallbackTimeoutMs())} for ONE non-streamed completion (no tokens stream while it runs; esc abandons it)`
      const noticeError = pass.streamIdleAborted
        ? Object.assign(
            new Error(
              pass.sawFirstStreamEvent
                ? `stream idle watchdog fired after ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} of mid-stream silence (${pass.streamEventCount} event(s) arrived, then the stream went quiet — the connection likely dropped) — ${fallbackWaitWords}`
                : streamIdleWatchdog.fired()?.noBytes === true
                  ? `${preEventSilenceWords()}, TWICE (the request authenticates and is accepted, then nothing arrives) — ${fallbackWaitWords}; /model can switch families meanwhile`
                  : `stream idle watchdog fired after ${patienceSeconds(STREAM_IDLE_TIMEOUT_MS)} with no first event, TWICE (the request authenticates and is accepted, then nothing arrives — a dead connection, or a request the server parks) — ${fallbackWaitWords}; /model can switch families meanwhile`,
            ),
            { cause: streamingError },
          )
        : cut !== null
          ? Object.assign(
              new Error(`${transportCutWords('Anthropic', cut)}${call.streamCutRetryUsed ? ', twice' : ''} — ${fallbackWaitWords}`),
              { cause: streamingError },
            )
          : (streamingError as APIError)
      yield createSystemAPIErrorMessage(noticeError, 0, 1, 1, {
        recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs(),
      })

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

      const nonStreamContent = Array.isArray(result.content) ? result.content : []
      noteServedModel(result.model)
      const m = mintAssistantMessage(result, nonStreamContent)
      newMessages.push(m)
      call.fallbackMessage = m
      if (isTurnOwningQuerySource(options.querySource)) noteRequestOnWire(rosterOwnerKey)
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
      logForDebugging(
        'The streaming endpoint answered 404; the request is retried as one shot',
        { level: 'warn' },
      )
      call.didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }
      yield createSystemAPIErrorMessage(
        errorFromRetry.originalError as APIError,
        0,
        1,
        1,
        { recoveryTimeoutMs: getNonstreamingFallbackTimeoutMs() },
      )

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

        const nonStreamContent = Array.isArray(result.content) ? result.content : []
        noteServedModel(result.model)
        const m = mintAssistantMessage(result, nonStreamContent)
        newMessages.push(m)
        call.fallbackMessage = m
        if (isTurnOwningQuerySource(options.querySource)) noteRequestOnWire(rosterOwnerKey)
        yield m

      } catch (fallbackError) {
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        logForDebugging(
          `The one-shot retry failed too: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        const { error, errorModel } = logRequestFailure(fallbackError)

        if (error instanceof APIUserAbortError) {
          yield* yieldAbortedPartialText()
          releaseStreamResources()
          return
        }

        if ((error as { status?: unknown }).status === 429) {
          await (await import('../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
        }
        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
          modelRefusalRequest: modelRefusalRequest.current,
        })
        releaseStreamResources()
        return
      }
    } else {
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      const { error, errorModel } = logRequestFailure(errorFromRetry)

      if (error instanceof APIUserAbortError) {
        yield* yieldAbortedPartialText()
        releaseStreamResources()
        return
      }

      if ((error as { status?: unknown }).status === 429) {
        await (await import('../catalogueOnDemand.js')).readCataloguesForOtherFamilies('anthropic')
      }
      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
        modelRefusalRequest: modelRefusalRequest.current,
      })
      releaseStreamResources()
      return
    }
  } finally {
    settleAttemptLedger(ctx, call)
  }

  closeSucceededRequest(ctx, call)
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
