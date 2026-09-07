
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import type {
  BetaContentBlock,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  getCacheEditingHeaderLatched,
  getLastApiCompletionTimestamp,
  getThinkingClearLatched,
  setLastMainRequestId,
  setThinkingClearLatched,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import {
  CONTEXT_MANAGEMENT_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { applyThinkingBinding } from './thinkingBinding.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/featureGates.js'
import type { AgentId } from 'src/types/ids.js'
import type { NativeWebSearchRequest } from 'src/services/search/nativeSearchRequest.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import {
  cacheClockObserve,
} from 'src/utils/cache/cacheClock.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import type { EffortValue } from 'src/utils/effort.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { roughTokenCountEstimation } from 'src/services/tokenEstimation.js'
import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { notePrintPhase } from 'src/utils/printPhases.js'
import { resetApiConnectionPool } from 'src/utils/proxy.js'
import {
  getActivePulseTrace,
  getPulsePhase,
  isPulseMainSource,
  notePulseStreamActivity,
  pulseMark,
  pulseStageEnd,
  pulseStageStart,
  setPulsePhase,
} from 'src/utils/pulse/index.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import { foldToolChoiceForModel, refusalFallbackRequest, servesPerMessageEffort } from 'src/utils/model/capabilities.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER, MID_CONVERSATION_OUTPUT_CONFIG_BETA_HEADER } from '../../../constants/betas.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
} from '../../../Tool.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { ensureGatewayProbe, gatewayProbePolicyAllows, type GatewayProbeAnswer } from '../deferralProbe.js'
import { gatewayHost } from '../deferralWire.js'
import { deadlineBreachLine, isDeadlineBreach } from '../fetchDeadline.js'
import { announcementMessage, conversationRosterKey, planToolPayload, renderAdmissionRecordsAsText } from '../toolEconomy.js'
import { declareLawfulPrefixChange } from '../lawfulPrefixChange.js'
import { applyInducedPrefixEdit, inducedEditApplies, judgeAndRecordPrefix, resolveInducedPrefixEdit, type WirePrefixParts } from './prefixLedger.js'
import { deadThinkingMarks, stripDeadThinking } from './thinkingBinding.js'
import type {
  ConnectorTextBlock,
  ConnectorTextDelta,
} from '../../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import type {
  ApiToolUnion,
  JsonOutputFormat,
  StreamCapabilityAdvertisement,
} from '../../../types/wire.js'
import { logAPIPrefix, toolToAPISchema } from '../../../utils/api.js'
import { count } from '../../../utils/array.js'
import {
  getMergedBetas,
  modelSupportsTemperature,
} from '../../../utils/betas.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
} from '../../../utils/context.js'
import { isTurnOwningQuerySource, resolveAppliedEffort } from '../../../utils/effort.js'
import { validateBoundedIntEnvVar } from '../../../utils/envValidation.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { errorMessage } from '../../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../../utils/fingerprint.js'
import { captureAPIRequest } from '../../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createSystemAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  orderToolResultsByUse,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
  stripUnsignedThinkingBlocks,
} from '../../../utils/messages.js'
import { stripThinkingFromIndex, stripThinkingFromOtherModels } from '../../../utils/messages/apiFilters.js'
import { processOwnerForLane } from '../../run/resolveOwner.js'
import {
  getCanonicalName,
  getPublicModelDisplayName,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../../utils/model/model.js'
import { sessionSmallFastModel } from '../../../utils/model/providerFrontier.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../../utils/sessionActivity.js'
import { settleTranscriptMessage } from '../../../utils/sessionStorage/writer.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../../utils/tokens.js'
import {
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../../claudeAiLimits.js'
import { getAPIContextManagement } from '../../compact/apiMicrocompact.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
} from '../../compact/microCompact.js'
import { getInitializationStatus } from '../../lsp/manager.js'
import { withStreamingVCR, withVCR } from '../../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from '../../api/client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
  malformedStreamFrameText,
} from '../../api/errors.js'
import {
  EMPTY_USAGE,
  logAPIError,
  logAPIQuery,
  logAPIDuration,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from '../../api/logging.js'
import {
  CACHE_TTL_1HOUR_MS,
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
  type RetryContext,
  withRetry,
} from '../../api/withRetry.js'
import {
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  type CachedMCEditsBlock,
  type CachedMCPinnedEdits,
  cleanupStream,
  updateUsage,
} from './cacheAndUsage.js'
import { getPreviousRequestIdFromMessages, stripExcessMediaItems } from './media.js'
import {
  coldPrefixOf,
  estimateRequestTokens,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  requestWaitLine,
  retryReasonWords,
  streamActivityFetchOptions,
  createStreamIdleWatchdog,
  streamEndReceiptLine,
  streamIdleTimeoutMsForRoute,
  streamIdleWarningMsOf,
  type RequestWaitV1,
  type StreamEndV1,
} from '../streamIdleBudget.js'
import { nonstreamingFallbackCeilingMs, patienceSeconds } from '../patience.js'
import {
  configureEffortParams,
  configureTaskBudgetParams,
  getAPIMetadata,
  getExtraBodyParams,
  getPromptCachingEnabled,
  type TaskBudgetParam,
} from './requestParams.js'

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
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: ApiToolUnion[]
  nativeWebSearch?: NativeWebSearchRequest
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  onWait?: (wait: RequestWaitV1 | null) => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  cacheTtlSource?: QuerySource
  effortMessage?: EffortValue
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId
  ownerKey?: string
  outputFormat?: JsonOutputFormat
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  taskBudget?: { total: number; remaining?: number }
  callReference?: ModelCallReference
}

export {
  accumulateUsage,
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  cleanupStream,
  updateUsage,
} from './cacheAndUsage.js'

export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
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

const GATEWAY_PROBE_TIMEOUT_MS = 8_000
async function sendGatewayProbe(
  body: Record<string, unknown>,
  betaHeader: string,
  options: Options,
): Promise<GatewayProbeAnswer> {
  try {
    const client = await getAnthropicClient({
      maxRetries: 0,
      fetchOverride: options.fetchOverride,
      source: options.querySource,
    })
    await client.beta.messages.create(
      { ...body, betas: [betaHeader] } as never,
      { timeout: GATEWAY_PROBE_TIMEOUT_MS, maxRetries: 0 },
    )
    return { status: 200, bodyText: '' }
  } catch (error) {
    if (isDeadlineBreach(error)) {
      return { status: null, bodyText: deadlineBreachLine('the gateway', GATEWAY_PROBE_TIMEOUT_MS) }
    }
    const status = (error as { status?: unknown }).status
    return {
      status: typeof status === 'number' ? status : null,
      bodyText: error instanceof Error ? error.message : String(error),
    }
  }
}

function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  return status.status === 'pending' || status.status === 'not-started'
}

function getNonstreamingFallbackTimeoutMs(): number {
  return nonstreamingFallbackCeilingMs()
}

export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  originatingRequestId?: string | null,
  afterSilence?: { idleMs: number; model: string },
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs,
          },
        )
      } catch (err) {
        if (err instanceof APIUserAbortError) throw err

        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        if (afterSilence !== undefined && isFirstByteTimeout(err)) {
          throw new Error(
            `the stream went quiet for ${patienceSeconds(afterSilence.idleMs)} and one non-streamed answer got nothing in ${patienceSeconds(fallbackTimeoutMs)} from ${afterSilence.model} — no keep-alive arrived: a dead connection, or a request the provider parked; the turn was ended`,
          )
        }
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
}

function isFirstByteTimeout(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true
  return error instanceof Error && error.constructor?.name === 'APIConnectionTimeoutError'
}

async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolvedModel = options.model

  const pulseMain = isPulseMainSource(options.querySource, options.agentId)
  if (pulseMain) pulseStageStart('tool_schema')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

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
    alsoDefer: shouldDeferLspTool,
  })
  const useToolSearch = plan.enabled
  const deferredToolNames = plan.deferredNames
  const blockForm = plan.wireForm === 'block'
  const filteredTools: Tools = plan.roster
  if (!useToolSearch) {
    logForDebugging('Tool search disabled for this request (the payload plan)')
  }
  if (plan.restoredMissingTools.length > 0) {
    declareLawfulPrefixChange(
      rosterOwnerKey,
      `a tool the earlier session offered is no longer available (${plan.restoredMissingTools.join(', ')})`,
    )
  }

  if (useToolSearch && plan.wireWhy === 'gateway-unprobed' && gatewayProbePolicyAllows()) {
    const host = gatewayHost()
    if (host !== null) {
      void ensureGatewayProbe(
        host,
        (body, betaHeader) => sendGatewayProbe(body, betaHeader, options),
        options.model,
      )
    }
  }

  const toolSearchHeader = useToolSearch && blockForm ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && !betas.includes(toolSearchHeader)) {
    betas.push(toolSearchHeader)
  }

  const cachedMCEnabled = false
  const cacheEditingBetaHeader = ''

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  const willDefer = (t: Tool) => useToolSearch && blockForm && deferredToolNames.has(t.name)
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  if (pulseMain) pulseStageEnd('tool_schema')

  if (pulseMain) pulseStageStart('message_normalization')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  if (pulseMain) pulseStageEnd('message_normalization')

  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  } else if (!blockForm) {
    messagesForAPI = renderAdmissionRecordsAsText(messagesForAPI).map(msg =>
      msg.type === 'assistant' ? stripCallerFieldFromAssistantMessage(msg) : msg,
    )
  }

  messagesForAPI = orderToolResultsByUse(ensureToolResultPairing(messagesForAPI))

  messagesForAPI = stripUnsignedThinkingBlocks(messagesForAPI)

  messagesForAPI = stripThinkingFromOtherModels(
    messagesForAPI,
    options.model,
    (a, b) => getCanonicalName(a) === getCanonicalName(b),
  )

  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  messagesForAPI = stripDeadThinking(messagesForAPI, deadThinkingMarks(messages))
  if (thinkingConfig.type === 'disabled') messagesForAPI = stripThinkingFromIndex(messagesForAPI, 0)

  const fingerprint = computeFingerprintFromMessages(messages)

  const announcement = announcementMessage(plan)
  if (announcement !== null) {
    messagesForAPI = [announcement, ...messagesForAPI]
  }

  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  logAPIPrefix(systemPrompt)

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const cacheTtlSource = options.cacheTtlSource ?? options.querySource
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: cacheTtlSource,
  })
  const useBetas = betas.length > 0

  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (options.nativeWebSearch) {
    const { allowedDomains, blockedDomains, maxUses } = options.nativeWebSearch
    extraToolSchemas.push({
      type: 'web_search_20250305',
      name: 'web_search',
      ...(allowedDomains && allowedDomains.length > 0 ? { allowed_domains: allowedDomains } : {}),
      ...(blockedDomains && blockedDomains.length > 0 ? { blocked_domains: blockedDomains } : {}),
      max_uses: maxUses,
    })
  }
  if (advisorModel) {
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as ApiToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas] as unknown as BetaToolUnion[]


  const cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true

  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      isEnvTruthy(process.env.MERCURY_THINKING_CLEAR_NOW) ||
      (lastCompletion !== null &&
        Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS)
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue, { agentId: options.agentId })

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let settledNormally = false
  let attemptNumber = 0
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- the SDK returns a fetch Response
  let streamResponse: Response | undefined = undefined

  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    const extraBodyParams = getExtraBodyParams([])

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    const refusalFallback = useBetas ? refusalFallbackRequest(options.model) : null
    if (refusalFallback && !betasParams.includes(refusalFallback.beta)) {
      betasParams.push(refusalFallback.beta)
    }

    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking = thinkingConfig.type !== 'disabled'
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    if (hasThinking && modelSupportsThinking(options.model)) {
      if (modelSupportsAdaptiveThinking(options.model)) {
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    thinking = applyThinkingBinding(thinking, betasParams) as typeof thinking
    const sendBetas = betasParams.length > 0

    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    const useCachedMC =
      cachedMCEnabled &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    const temperature =
      !hasThinking && modelSupportsTemperature(options.model)
        ? (options.temperatureOverride ?? 1)
        : undefined

    const toolChoice = foldToolChoiceForModel(options.model, options.toolChoice)
    if (toolChoice !== options.toolChoice) {
      logForDebugging(
        `forced tool_choice folded to auto for ${options.model} (the model rejects forced tool choice)`,
      )
    }

    const prefixKey = conversationRosterKey(rosterOwnerKey, messages, options.model)
    let wireParts: WirePrefixParts = {
      system,
      tools: allTools,
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        cacheTtlSource,
        useCachedMC,
        consumedCacheEdits as CachedMCEditsBlock | null,
        consumedPinnedEdits as CachedMCPinnedEdits[],
        options.skipCacheWrite,
      ),
    }
    const inducedEdit = resolveInducedPrefixEdit()
    if (inducedEdit !== null && inducedEditApplies(messages)) wireParts = applyInducedPrefixEdit(wireParts, inducedEdit)
    const effortRow = perMessageEffortRow(options.model, options.effortMessage)
    const wireMessages = effortRow === null ? wireParts.messages : insertBeforeLastUserRow(wireParts.messages as ReadonlyArray<{ role?: string }>, effortRow)
    const rowAt = effortRow === null ? -1 : (wireMessages as ReadonlyArray<unknown>).indexOf(effortRow)
    const sourceIds = messagesForAPI.map(m => (m.type === 'assistant' ? m.message.id : null))
    const wireMessageIds = rowAt === -1 ? sourceIds : [...sourceIds.slice(0, rowAt), null, ...sourceIds.slice(rowAt)]
    judgeAndRecordPrefix(rosterOwnerKey, prefixKey, wireParts, wireMessageIds, {
      replaceRecord: isTurnOwningQuerySource(options.querySource),
    })

    if (effortRow !== null && !betasParams.includes(MID_CONVERSATION_OUTPUT_CONFIG_BETA_HEADER)) {
      betasParams.push(MID_CONVERSATION_OUTPUT_CONFIG_BETA_HEADER)
    }

    return {
      model: normalizeModelStringForAPI(options.model),
      messages: wireMessages as ReturnType<typeof addCacheBreakpoints>,
      system: wireParts.system as typeof system,
      tools: wireParts.tools as typeof allTools,
      tool_choice: toolChoice,
      ...(refusalFallback && { fallbacks: refusalFallback.fallbacks }),
      ...((sendBetas || effortRow !== null) && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        sendBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
    }
  }

  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = queryParams.betas ?? []
    const logThinkingType = queryParams.thinking?.type ?? 'disabled'
    const logEffortValue = queryParams.output_config?.effort
    void options.getToolPermissionContext().then(permissionContext => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined = undefined
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  const stoppedBlockIndices = new Set<number>()
  let usage: NonNullableUsage = EMPTY_USAGE

  const requestedWire = normalizeModelStringForAPI(options.model)
  let servedModel: string | undefined
  let servedWholeTurn = false
  const noteServedModel = (
    model: string | undefined,
    learnedFrom: 'start' | 'block',
  ): void => {
    if (!model || model === servedModel) return
    if (getCanonicalName(model) === getCanonicalName(requestedWire)) return
    servedModel = model
    servedWholeTurn = learnedFrom === 'start'
    logForDebugging(
      `served by ${model} (requested ${requestedWire}; ${learnedFrom === 'start' ? 'the whole turn' : 'from a mid-output handover'})`,
    )
    if (pulseMain) {
      setPulsePhase(getActivePulseTrace()?.generation ?? 0, getPulsePhase().phase, {
        servedBy: getPublicModelDisplayName(model) ?? model,
      })
    }
  }
  const pricingModel = (): string =>
    servedModel && servedWholeTurn ? servedModel : resolvedModel
  let stopReason: BetaStopReason | null = null
  let ledgerSettled = false
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let isAdvisorInProgress = false
  let preFirstEventStreamRetryUsed = false

  const mintAssistantMessage = (
    base: BetaMessage,
    blocks: BetaContentBlock[],
  ): AssistantMessage => ({
    message: {
      ...base,
      ...(servedModel && { model: servedModel }),
      content: normalizeContentFromAPI(blocks, tools, options.agentId),
    },
    requestId: streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...(advisorModel && { advisorModel }),
  })

  function* yieldAbortedPartialText(): Generator<AssistantMessage> {
    if (!partialMessage) return
    const inFlight = contentBlocks.filter(
      (b, i) =>
        b !== undefined &&
        !stoppedBlockIndices.has(i) &&
        b.type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string' &&
        (b as { text: string }).text.length > 0,
    )
    if (inFlight.length === 0) return
    const m = mintAssistantMessage(
      partialMessage,
      inFlight as BetaContentBlock[],
    )
    newMessages.push(m)
    yield m
  }

  const settleUnpricedAttempt = (): void => {
    if (ledgerSettled || partialMessage === undefined) return
    ledgerSettled = true
    let streamedText = ''
    for (const block of contentBlocks) {
      if (block === undefined) continue
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') streamedText += text
      const thinking = (block as { thinking?: unknown }).thinking
      if (typeof thinking === 'string') streamedText += thinking
    }
    const settled: NonNullableUsage = {
      ...usage,
      output_tokens: Math.max(
        usage.output_tokens,
        roughTokenCountEstimation(streamedText),
      ),
    }
    addToTotalSessionCost(
      calculateUSDCost(pricingModel(), settled),
      settled,
      pricingModel(),
    )
  }

  const logRequestFailure = (
    thrown: unknown,
  ): { error: unknown; errorModel: string } => {
    let error = thrown
    let errorModel = options.model
    if (thrown instanceof CannotRetryError) {
      error = thrown.originalError
      errorModel = thrown.retryContext.model
    }

    if (error instanceof APIError) {
      extractQuotaStatusFromError(error)
    }

    const requestId =
      streamRequestId ||
      (error instanceof APIError ? error.requestID : undefined) ||
      (error instanceof APIError
        ? (error.error as { request_id?: string })?.request_id
        : undefined)

    logAPIError({
      error,
      model: errorModel,
      messageCount: messagesForAPI.length,
      messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
      durationMs: Date.now() - start,
      durationMsIncludingRetries: Date.now() - startIncludingRetries,
      attempt: attemptNumber,
      requestId,
      clientRequestId,
      didFallBackToNonStreaming,
      queryTracking: options.queryTracking,
      querySource: options.querySource,
      previousRequestId,
    })

    return { error, errorModel }
  }

  try {
    streamingPass: for (;;) {
    if (pulseMain) pulseStageStart('client_setup')
    let noteTransportActivity: (() => void) | null = null
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        start = Date.now()
        if (pulseMain) pulseStageEnd('client_setup')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource)

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

        maxOutputTokens = params.max_tokens

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
        options.onWait?.(wait)

        if (pulseMain) {
          pulseMark('api_request_sent')
          setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'waiting', { wait: requestWaitLine(wait) })
        }
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
          notePrintPhase('dispatch')
        }

        clientRequestId = isFirstPartyAnthropicBaseUrl() ? randomUUID() : undefined

        const dispatch = () =>
          anthropic.beta.messages
            .create(
              { ...params, stream: true },
              {
                signal,
                timeout: wait.budgetMs,
                fetchOptions: streamActivityFetchOptions(() => noteTransportActivity?.()) as never,
                ...(clientRequestId && {
                  headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
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
            throw new APIConnectionTimeoutError({ message: firstByteTimeoutLine(wait) })
          }
          throw sent
        }
        options.onWait?.(null)
        if (pulseMain) {
          pulseMark('response_headers_received')
          setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'waiting', { wait: undefined })
        }
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        signal,
        querySource: options.querySource,
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
          if (pulseMain) setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'waiting', { wait: requestWaitLine(retryWait) })
        }
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    settleUnpricedAttempt()
    newMessages.length = 0
    ttftMs = 0
    partialMessage = undefined
    contentBlocks.length = 0
    stoppedBlockIndices.clear()
    usage = EMPTY_USAGE
    stopReason = null
    ledgerSettled = false
    isAdvisorInProgress = false

    const STREAM_IDLE_TIMEOUT_MS = streamIdleTimeoutMsForRoute('anthropic')
    const STREAM_IDLE_WARNING_MS = streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)
    let streamIdleAborted = false
    let streamedToolUse = false
    let sawFirstStreamEvent = false
    let streamEventCount = 0
    let streamWatchdogFiredAt: number | null = null
    let sawMessageStop = false
    const streamIdleWatchdog = createStreamIdleWatchdog({
      timeoutMs: STREAM_IDLE_TIMEOUT_MS,
      onWarning: () => {
        logForDebugging(
          `stream silent for ${STREAM_IDLE_WARNING_MS / 1000}s — watchdog warning`,
          { level: 'warn' },
        )
        logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
      },
      onFire: () => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `stream silent for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — watchdog aborting the stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        releaseStreamResources()
      },
    })
    noteTransportActivity = () => streamIdleWatchdog.noteActivity()
    function clearStreamIdleTimers(): void {
      noteTransportActivity = null
      streamIdleWatchdog.stop()
    }
    function settledTailStands(): boolean {
      if (!partialMessage || newMessages.length === 0 || stopReason !== null || streamedToolUse) return false
      let last: (typeof contentBlocks)[number] | undefined
      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i]
        if (block === undefined) continue
        if (!stoppedBlockIndices.has(i)) return false
        last = block
      }
      return last !== undefined && last.type === 'text'
    }
    function* settleTypedEnd(end: StreamEndV1) {
      const lastMsg = newMessages.at(-1)
      if (!lastMsg) return
      stopReason = 'end_turn'
      lastMsg.message.usage = usage as AssistantMessage['message']['usage']
      lastMsg.message.stop_reason = 'end_turn'
      lastMsg.streamEnd = end
      void settleTranscriptMessage(lastMsg)
      logForDebugging(streamEndReceiptLine(end), { level: 'warn' })
      yield {
        type: 'stream_event' as const,
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage,
        } as unknown as BetaRawMessageStreamEvent,
      }
      yield {
        type: 'stream_event' as const,
        event: { type: 'message_stop' } as BetaRawMessageStreamEvent,
      }
    }

    startSessionActivity('api_call')
    try {
      let isFirstChunk = true
      let lastEventTime: number | null = null
      const STALL_THRESHOLD_MS = 30_000
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of stream) {
        streamIdleWatchdog.noteActivity()
        sawFirstStreamEvent = true
        streamEventCount++
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
          if (pulseMain) {
            pulseMark('first_stream_chunk_received')
            notePulseStreamActivity(
              getActivePulseTrace()?.generation ?? 0,
              'chunk',
            )
          }
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk')
            notePrintPhase('first_byte')
          }
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            partialMessage = part.message
            ttftMs = Date.now() - start
            usage = updateUsage(usage, part.message?.usage)
            noteServedModel(part.message?.model, 'start')
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
                if ((part.content_block.name as string) === 'advisor') {
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
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
                if ((part.content_block.type as string) === 'fallback') {
                  noteServedModel(
                    (part.content_block as { to?: { model?: string } }).to?.model,
                    'block',
                  )
                }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
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
            if (!partialMessage) {
              throw new Error('Message not found')
            }
            const m = mintAssistantMessage(partialMessage, [
              contentBlock,
            ] as BetaContentBlock[])
            stoppedBlockIndices.add(part.index)
            if (contentBlock.type === 'tool_use') {
              streamedToolUse = true
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            if (part.delta == null) {
              throw new Error(malformedStreamFrameText('message_delta', 'delta'))
            }
            usage = updateUsage(usage, part.usage)

            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage as AssistantMessage['message']['usage']
              lastMsg.message.stop_reason = stopReason
              void settleTranscriptMessage(lastMsg)
            }

            const costUSDForPart = calculateUSDCost(pricingModel(), usage)
            addToTotalSessionCost(costUSDForPart, usage, pricingModel())
            ledgerSettled = true

            void checkResponseForCacheBreak(
              options.querySource,
              usage.cache_read_input_tokens,
              usage.cache_creation_input_tokens,
              messages,
              options.agentId,
              clientRequestId ?? null,
            )

            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
              { requestId: clientRequestId ?? null, raw: part.delta },
            )
            if (refusalMessage) {
              yield refusalMessage
            }

            if (stopReason === 'max_tokens') {
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Mercury's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the MERCURY_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            if (stopReason === 'model_context_window_exceeded') {
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'message_stop':
            sawMessageStop = true
            setLastApiCompletionTimestamp(Date.now())
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
        if (sawMessageStop) break
      }
      clearStreamIdleTimers()

      if (streamIdleAborted) {
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logForDebugging(
          `stream loop exited ${exitDelayMs}ms after watchdog abort (clean exit)`,
        )
        streamWatchdogFiredAt = null
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

      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'stream closed before message_start — routing to the non-streaming fallback'
            : 'stream closed after message_start with no completed block and no stop_reason — routing to the non-streaming fallback',
          { level: 'error' },
        )
        throw new Error('Stream ended without receiving any events')
      }
      if (stopReason === null && settledTailStands()) {
        yield* settleTypedEnd({ reason: 'closed-after-last-item', provider: 'Anthropic' })
      }

      if (stallCount > 0) {
        logForDebugging(
          `stream finished carrying ${stallCount} stall(s), ${(totalStallTime / 1000).toFixed(1)}s stalled in total`,
          { level: 'warn' },
        )
      }

      cacheClockObserve({
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTotal: usage.cache_creation_input_tokens,
        cacheCreation5m: usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
        cacheCreation1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
        uncachedInputTokens: usage.input_tokens,
        now: Date.now(),
      })

      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
      }
    } catch (streamingError) {
      clearStreamIdleTimers()

      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logForDebugging(
          `stream loop exited ${exitDelayMs}ms after watchdog abort (error exit)`,
        )
      }

      if (streamIdleAborted && !signal.aborted && settledTailStands()) {
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
          if (isAdvisorInProgress) {
            logForDebugging('[AdvisorTool] user abort landed mid-advisor-call')
          }
          throw streamingError
        } else {
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      const disableFallback =
        isEnvTruthy(process.env.MERCURY_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'mercury_disable_streaming_to_non_streaming_fallback',
          false,
        ) ||
        (streamIdleAborted && streamedToolUse)

      if (disableFallback) {
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        throw streamingError
      }

      if (
        streamIdleAborted &&
        !sawFirstStreamEvent &&
        !preFirstEventStreamRetryUsed
      ) {
        preFirstEventStreamRetryUsed = true
        resetApiConnectionPool()
        logForDiagnosticsNoPII('info', 'cli_stream_preevent_streaming_retry')
        logForDebugging(
          `watchdog: no stream events within ${STREAM_IDLE_TIMEOUT_MS / 1000}s of dispatch — reissuing the stream (pass 2)`,
          { level: 'warn' },
        )
        yield createSystemAPIErrorMessage(
          Object.assign(
            new Error(
              `no stream events within ${STREAM_IDLE_TIMEOUT_MS / 1000}s of dispatch — the request was accepted and the wait is provider-side (a switched or uncached prompt can ingest slowly); reissuing the stream`,
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

      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      if (streamIdleAborted) resetApiConnectionPool()
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }
      const fallbackCeilingSeconds = Math.round(getNonstreamingFallbackTimeoutMs() / 1000)
      const fallbackWaitWords = `waiting up to ${fallbackCeilingSeconds}s for ONE non-streamed completion (no tokens stream while it runs; esc abandons it)`
      const noticeError = streamIdleAborted
        ? Object.assign(
            new Error(
              sawFirstStreamEvent
                ? `stream idle watchdog fired after ${STREAM_IDLE_TIMEOUT_MS / 1000}s of mid-stream silence (${streamEventCount} event(s) arrived, then the stream went quiet — the connection likely dropped) — ${fallbackWaitWords}`
                : `stream idle watchdog fired after ${STREAM_IDLE_TIMEOUT_MS / 1000}s with no first event, TWICE (the request authenticates and is accepted, then nothing arrives — a dead connection, or a request the server parks) — ${fallbackWaitWords}; /model can switch families meanwhile`,
            ),
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
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        params => captureAPIRequest(params, options.querySource),
        streamRequestId,
        streamIdleAborted
          ? { idleMs: STREAM_IDLE_TIMEOUT_MS, model: getPublicModelDisplayName(options.model) ?? options.model }
          : undefined,
      )

      noteServedModel(
        result.model,
        result.content.some(b => (b.type as string) === 'fallback') ? 'block' : 'start',
      )
      const m = mintAssistantMessage(result, result.content)
      newMessages.push(m)
      fallbackMessage = m
      yield m
    } finally {
      clearStreamIdleTimers()
    }
    break
    }
    settledNormally = true
  } catch (errorFromRetry) {
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
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
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        noteServedModel(
          result.model,
          result.content.some(b => (b.type as string) === 'fallback') ? 'block' : 'start',
        )
        const m = mintAssistantMessage(result, result.content)
        newMessages.push(m)
        fallbackMessage = m
        yield m

      } catch (fallbackError) {
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        const { error, errorModel } = logRequestFailure(fallbackError)

        if (error instanceof APIUserAbortError) {
          yield* yieldAbortedPartialText()
          releaseStreamResources()
          return
        }

        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
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

      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    stopSessionActivity('api_call')
    releaseStreamResources()

    settleUnpricedAttempt()
    if (!settledNormally) logAPIDuration({ start, startIncludingRetries })

    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(
        pricingModel(),
        fallbackUsage as NonNullableUsage,
      )
      addToTotalSessionCost(
        fallbackCost,
        fallbackUsage as NonNullableUsage,
        pricingModel(),
      )
    }
  }

  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  void options.getToolPermissionContext().then(() => {
    logAPISuccessAndDuration({
      start,
      startIncludingRetries,
    })
  })

  releaseStreamResources()
}

type SmallFastOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

export async function querySmallFast({
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
  options: SmallFastOptions
}): Promise<AssistantMessage> {
  return queryWithModel({
    systemPrompt,
    userPrompt,
    outputFormat,
    signal,
    options: {
      ...options,
      model: sessionSmallFastModel(),
    },
  })
}

type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

export async function queryWithModel({
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
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const { routedCallModel, settleAssistantTurn } = await import(
    '../../providers/callModelRouter.js'
  )
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const settled: AssistantMessage[] = []
      for await (const message of routedCallModel({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })) {
        if (message.type === 'assistant') {
          settled.push(message as AssistantMessage)
        }
      }
      return [settleAssistantTurn(settled, signal.aborted)]
    },
  )
  return result[0]! as AssistantMessage
}

export const MAX_NON_STREAMING_TOKENS = 64_000

export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1,
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

function isMaxTokensCapEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_otk_slot_v1', false)
}

export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  const result = validateBoundedIntEnvVar(
    'MERCURY_MAX_OUTPUT_TOKENS',
    process.env.MERCURY_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}

export function perMessageEffortRow(model: string, effort: EffortValue | undefined): { role: 'system'; content: []; output_config: { effort: string } } | null {
  if (typeof effort !== 'string' || !servesPerMessageEffort(model)) return null
  return { role: 'system', content: [], output_config: { effort } }
}

export function insertBeforeLastUserRow<T extends { role?: string }>(messages: readonly T[], row: unknown): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return [...messages.slice(0, i), row as T, ...messages.slice(i)]
  }
  return [...messages, row as T]
}
