// providers/anthropic/streamCore — the Anthropic request core: the Options
// vocabulary, queryModel's streaming generator (SSE assembly, watchdog,
// stall accounting, explicit settlement), the non-streaming fallback
// ladder, resource release, and the queryWithModel/querySmallFast
// entrypoints with output-token ceilings. Mercury-owned. PRESERVE-CONTRACT: the
// DISABLE_EXPERIMENTAL_BETAS guard and the retry/backoff semantics.
//
// The Anthropic wire streams the canonical grammar
// natively — the advertisement below is declared at the codec owner.

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
} from 'src/bootstrap/state.js'
import {
  CONTEXT_1M_BETA_HEADER,
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
import {
  foldToolChoiceForModel,
  refusalFallbackRequest,
} from 'src/utils/model/capabilities.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../../constants/betas.js'
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
import { announcementMessage, planToolPayload, renderAdmissionRecordsAsText } from '../toolEconomy.js'
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
  getSonnet1mExpTreatmentEnabled,
} from '../../../utils/context.js'
import { resolveAppliedEffort } from '../../../utils/effort.js'
import { apiTimeoutMsOverride, validateBoundedIntEnvVar } from '../../../utils/envValidation.js'
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
import { stripThinkingFromOtherModels } from '../../../utils/messages/apiFilters.js'
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
import { streamIdleTimeoutMs, streamIdleWarningMsOf } from '../streamIdleBudget.js'
import {
  configureEffortParams,
  configureTaskBudgetParams,
  getAPIMetadata,
  getExtraBodyParams,
  getPromptCachingEnabled,
  type TaskBudgetParam,
} from './requestParams.js'

// The stream-capability truth for the Anthropic lane: every field
// answers "does THIS file's SSE handling decode that natively?"
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
  // (: the app speaks Mercury's wire vocabulary; this leaf casts
  // to SDK shapes at its own boundary.)
  isNonInteractiveSession: boolean
  extraToolSchemas?: ApiToolUnion[]
  /** The provider-NEUTRAL native web-search request (services/search): a
   *  lane whose wire carries a search construct maps it onto its own
   *  spelling — here the web_search_20250305 server tool; the OpenAI lane
   *  the Responses hosted tool. The search door sets it only for a session
   *  whose main model IS that family. */
  nativeWebSearch?: NativeWebSearchRequest
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // Only set for subagents
  outputFormat?: JsonOutputFormat
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  // API-side pacing budget (output_config.task_budget) — distinct from the
  // local auto-continue budget: this one travels on the wire so the model
  // can pace itself; `remaining` is decremented by the caller across the
  // agentic loop.
  taskBudget?: { total: number; remaining?: number }
  /** The step's frozen capability/tool reference (run-core mint) —
   *  carried into the lane's prompt-state snapshot so cache-break receipts
   *  correlate to the exact sampling step. */
  callReference?: ModelCallReference
}

// The converter/params/media/usage machinery lives in owned submodules
// (R6); the barrel keeps re-exporting the shared five from here.
export {
  accumulateUsage,
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  cleanupStream,
  updateUsage,
} from './cacheAndUsage.js'

/**
 * Drain queryModel to its final assistant message. The generator is
 * consumed to completion even after the message arrives — the success
 * bookkeeping runs after the last yield. An abort surfaces as
 * APIUserAbortError so callers can treat it as a cancellation, not a
 * failure.
 */
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

/** An LSP tool ships defer_loading while the language servers are still
 *  coming up — the schema exists, the tool just isn't ready to call. */
/** The gateway probe's one request, bounded and output-capped, through
 *  this lane's own client and auth (../deferralProbe.ts owns the shape, the
 *  classification and the verdict store). The deadline rides the SDK's own
 *  request timeout and a breach reads in the provider-deadline law's words
 *  (never the runtime's abort spelling). Never throws: the wire's answer —
 *  a status and its message — or a null status when nothing answered. */
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

/**
 * Per-attempt ceiling for the non-streaming fallback, in ms. API_TIMEOUT_MS
 * overrides so slow backends govern both paths with one knob; the 300s
 * default leaves headroom under the API's ten-minute non-streaming bound.
 */
function getNonstreamingFallbackTimeoutMs(): number {
  // The ONE parser (envValidation): '60s' no longer reads as a 60ms ceiling
  // (TASK-017 S2, api-timeout-ms-three-parsers-no-floor).
  return apiTimeoutMsOverride() ?? 300_000
}

/**
 * The shared engine of every non-streaming request: a withRetry generator
 * that yields its system (error/notice) messages through and returns the
 * final BetaMessage. Timeouts are instrumented so "hit the bounded
 * timeout" is distinguishable from "hung past it".
 */
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
  /** Request id of the failed STREAMING attempt this call recovers from. */
  originatingRequestId?: string | null,
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
        // biome-ignore lint/plugin: the fallback path is the sanctioned direct create()
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
        // A user abort is a cancellation, not a failure — no probe fires.
        if (err instanceof APIUserAbortError) throw err

        // The probe that separates "bounded timeout fired" (this event
        // exists) from "hung past the container kill" (it doesn't).
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
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

  // Pump: pass system messages through, return the final message.
  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
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
  // Request lineage rides the message array, never global state: each
  // chain (main thread, every subagent, every teammate) carries its own,
  // and rollback/undo self-corrects because removed messages stop counting.
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  const resolvedModel = options.model

  // fence: only the operator's own model call narrates the trace —
  // subagent and service streams run through here concurrently.
  const pulseMain = isPulseMainSource(options.querySource, options.agentId)
  if (pulseMain) pulseStageStart('tool_schema')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // The advisor beta header travels with EVERY query while advisor is on:
  // non-agentic queries (compact, side questions, memory extraction) must
  // still parse advisor server_tool_use blocks already in the history.
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
        // Experiment pairing overrides only when the base model matches —
        // experiments exist precisely where the user cannot configure.
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

  // The tool-payload plan: the ONE owner every route consumes
  // (../toolEconomy.ts) — the mode ladder (TstAuto may size MCP tool
  // descriptions before deciding), the deferrable set under the live
  // permission mode, the pending-server hold, and the roster law: with
  // search on, the non-deferred tools, ToolSearch itself and exactly the
  // deferred tools this conversation has ADMITTED; with search off,
  // everything except ToolSearch. This lane reads the plan's roster,
  // announcement and WIRE FORM — the first-party request is byte-for-byte
  // what this lane always assembled; a gateway that cannot carry the beta
  // block form rides the text form instead of switching deferral off.
  const plan = await planToolPayload({
    model: options.model,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
  })
  const useToolSearch = plan.enabled
  const deferredToolNames = plan.deferredNames
  const blockForm = plan.wireForm === 'block'
  const filteredTools: Tools = plan.roster
  if (!useToolSearch) {
    logForDebugging('Tool search disabled for this request (the payload plan)')
  }

  // A gateway nobody has probed rides the text form — the whole economy,
  // nothing a gateway can 400. The probe — one bounded, output-capped
  // request in the block shape through this lane's own client and auth —
  // is ARMED by the operator (MERCURY_TOOL_DEFER_PROBE=1): it runs at most
  // once per process per host and records a durable verdict for every
  // later request. It is not the default because it is one request the
  // session did not ask for, and the text form already pays nothing extra.
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

  // defer_loading needs its beta header (first-party spelling — the gateway
  // per-provider split retired with the gateway estate) — the block form
  // only; a text-form gateway would 400 on it.
  const toolSearchHeader = useToolSearch && blockForm ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && !betas.includes(toolSearchHeader)) {
    betas.push(toolSearchHeader)
  }

  // Cached microcompact is not live in Mercury: the enablement stays a
  // constant false and the header string never loads. The plumbing below
  // (useCachedMC, consumed edits) keeps the wire path exercised by tests
  // and ready for the flag.
  const cachedMCEnabled = false
  const cacheEditingBetaHeader = ''

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  // The defer_loading mark is a block-form field; the text form carries no
  // per-schema deferral field at all.
  const willDefer = (t: Tool) =>
    useToolSearch && blockForm && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // MCP tools are per-user, so a rendered MCP tool forces the dynamic tool
  // section and forfeits global caching. A deferred one renders nothing
  // and forfeits nothing.
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // Schema build gets the FULL tools list even though only filteredTools
  // ship: ToolSearchTool's prompt must list every discoverable MCP tool —
  // filtering governs what the API receives, not what the model can find.
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

  // Second, model-aware strip on top of normalizeMessagesForAPI: that pass
  // runs from ~20 call sites without model context (its signature can't
  // grow one cheaply), so the model-conditional part happens here — which
  // also covers mid-conversation model switches, where stale tool-search
  // fields from the previous model would 400. Assistant inputs are already
  // normalized; only the `caller` field still needs removing there.
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
    // The text form: an admission record renders as text (this wire cannot
    // expand a tool_reference, and without the beta header the block is a
    // 400), and the beta-only caller field never rides.
    messagesForAPI = renderAdmissionRecordsAsText(messagesForAPI).map(msg =>
      msg.type === 'assistant' ? stripCallerFieldFromAssistantMessage(msg) : msg,
    )
  }

  // Heal pairing damage from resumed remote/teleport sessions: orphaned
  // tool_uses gain synthetic error results; orphaned tool_results
  // referencing nothing are dropped. Then every round's results take the
  // assistant's own tool_use order (a concurrent batch settles in arrival
  // order) — the same order every other wire replays.
  messagesForAPI = orderToolResultsByUse(ensureToolResultPairing(messagesForAPI))

  // Cross-provider transcripts: thinking minted by another
  // runtime is unsigned and the API rejects it (live-proved,
  // 'Invalid `signature` in `thinking` block'). Reasoning never
  // round-trips across providers; signed Anthropic thinking replays as-is.
  messagesForAPI = stripUnsignedThinkingBlocks(messagesForAPI)

  // Signed thinking written by ANOTHER Anthropic model (the conversation
  // switched models): the API drops it on every request that replays it
  // and names each block, so the operator would read the same drop notice
  // turn after turn. It leaves here instead — one quiet receipt per switch,
  // painted by the turn machine. Compared by canonical family, so an alias
  // never reads as a switch.
  messagesForAPI = stripThinkingFromOtherModels(
    messagesForAPI,
    options.model,
    (a, b) => getCanonicalName(a) === getCanonicalName(b),
  )

  // Advisor blocks without the advisor header are a 400 — strip them.
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // The media ceiling: past it the API errors unhelpfully, and callers in
  // driverless surfaces cannot recover — dropping the OLDEST media items
  // quietly is the lesser harm.
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // Fingerprint from the RAW conversation, so attribution reflects the
  // operator's actual input: the API view coalesces the harness's reminder
  // rows into the first turn, and a reminder that moves between requests
  // (re-emitted on resume, rebuilt on a new day) would move the fingerprint,
  // the attribution line, and with it the top-level system every thinking
  // block is bound to. The extractor skips meta rows and reminder blocks.
  const fingerprint = computeFingerprintFromMessages(messages)

  // Deferred-tool announcement (the plan's bytes: sorted name lines inside
  // the tag pair, null with the delta attachment on — persisted
  // deferred_tools_delta attachments carry it then, since the ephemeral
  // prepend busts cache every time the pool changes).
  const announcement = announcementMessage(plan)
  if (announcement !== null) {
    messagesForAPI = [announcement, ...messagesForAPI]
  }

  // Assemble the final system prompt; empty segments drop out of the join.
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
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  // The session's base beta list is in use at all: the refusal fallback
  // (FABLE51) arms only then. The betas TERM itself is decided per attempt
  // on betasParams, a superset, inside paramsFromContext.
  const useBetas = betas.length > 0

  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (options.nativeWebSearch) {
    // The neutral search request in THIS wire's spelling — the server tool
    // rides the tools array by API contract, appended after the cached
    // prefix like the advisor below.
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
    // Server tools belong in the tools array by API contract. Appending
    // AFTER toolSchemas (which carries the cache marker) means toggling
    // /advisor churns only the small suffix, never the cached prefix.
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as ApiToolUnion)
  }
  //  leaf boundary: Mercury-typed tool schemas enter the SDK
  // request here — the one cast for the tools truth.
  const allTools = [...toolSchemas, ...extraToolSchemas] as unknown as BetaToolUnion[]

  // Sticky-on latches for dynamic beta headers: once a header has been
  // sent, it keeps being sent for the session — a mid-session toggle that
  // changed the header set would change the server cache key and burn
  // ~50-70K cached tokens. /clear and /compact reset the latches. Per-call
  // gates (isAgenticQuery, main-thread-only) stay per-call so non-agentic
  // queries keep their own stable header sets.

  const cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true

  // The thinking-clear latch flips only from agentic queries — a
  // classifier call must not switch the main thread's context management
  // mid-turn.
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  const startIncludingRetries = Date.now()
  let start = Date.now()
  // True once the request settled through the success tail below (which
  // writes the API-duration ledger with the success marks); every other
  // exit writes the duration from the finally (FN-018 rank 11).
  let settledNormally = false
  let attemptNumber = 0
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- the SDK returns a fetch Response
  let streamResponse: Response | undefined = undefined

  // Release EVERYTHING the stream holds. The Response keeps native
  // TLS/socket buffers outside the V8 heap (GH #32920, Node/npm path);
  // they free only when the body is cancelled — however the generator
  // exits.
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // Consume pending cache edits ONCE, before paramsFromContext exists —
  // that closure runs per attempt and per logging call, and a consume
  // inside it would let the first call starve the rest.
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    // The Sonnet 1M experiment adds its header per retry-context model.
    if (
      !betasParams.includes(CONTEXT_1M_BETA_HEADER) &&
      getSonnet1mExpTreatmentEnabled(retryContext.model)
    ) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

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

    // The opt-in refusal fallback (MERCURY_REFUSAL_FALLBACK=1): the beta
    // header + `fallbacks: 'default'` on the models the refusals page
    // names, through the ONE owner. The serving model is never silent —
    // noteServedModel stamps it on the minted messages and the byline.
    const refusalFallback = useBetas ? refusalFallbackRequest(options.model) : null
    if (refusalFallback && !betasParams.includes(refusalFallback.beta)) {
      betasParams.push(refusalFallback.beta)
    }

    // Structured output rides output_config.format + its beta header.
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // Retry context outranks everything — it is how a context-window
    // overshoot course-corrects on the next attempt.
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking = thinkingConfig.type !== 'disabled'
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    // IMPORTANT: the adaptive-vs-budget selection below is quality-
    // sensitive — do not change it without the model launch DRI and
    // research signing off.
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (modelSupportsAdaptiveThinking(options.model)) {
        // Adaptive-capable models always run adaptive, budget-free.
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        // Budget models: the model default unless the config pinned one,
        // and never ≥ max_tokens (API constraint).
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

    // The preserved-thinking setting: block_binding.prefix_mismatch_behavior
    // + the controls header on every request that carries thinking
    // (./thinkingBinding.ts owns the value and the host gate). The betas
    // term is decided on the PER-ATTEMPT list below, never on the session's
    // base list: the field is a 400 without its header, so a request whose
    // only beta is this one must still carry the term.
    thinking = applyThinkingBinding(thinking, betasParams) as typeof thinking
    const sendBetas = betasParams.length > 0

    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // Cache editing latches its header; with the feature constant-off in
    // Mercury the branch never arms.
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

    // Temperature only when thinking is off (the API pins 1 with thinking
    // on) and only on models that accept the param at all — 5-family
    // models 400 on its mere presence.
    const temperature =
      !hasThinking && modelSupportsTemperature(options.model)
        ? (options.temperatureOverride ?? 1)
        : undefined

    // Forced tool choice (`any` / `tool`) folds to `auto` on a model that
    // rejects it (Claude Fable 5.1: a 400 naming both modes) — the prompt
    // still names the tool, the docs' own replacement. Everywhere else the
    // caller's choice rides verbatim.
    const toolChoice = foldToolChoiceForModel(options.model, options.toolChoice)
    if (toolChoice !== options.toolChoice) {
      logForDebugging(
        `forced tool_choice folded to auto for ${options.model} (the model rejects forced tool choice)`,
      )
    }

    return {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits as CachedMCEditsBlock | null,
        consumedPinnedEdits as CachedMCPinnedEdits[],
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: toolChoice,
      ...(refusalFallback && { fallbacks: refusalFallback.fallbacks }),
      // The betas term rides on the PER-ATTEMPT list (a superset of the
      // session's base list): the binding field is a 400 without its header.
      ...(sendBetas && { betas: betasParams }),
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

  // Log scalars are computed synchronously so the fire-and-forget .then
  // captures primitives only — not paramsFromContext's whole closure
  // (messages, system, tools), which would stay pinned until it resolves.
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
  // Indices whose content_block_stop already minted + yielded them; the
  // complement at a USER abort is the in-flight partial (the abort-partial
  // law below).
  const stoppedBlockIndices = new Set<number>()
  let usage: NonNullableUsage = EMPTY_USAGE

  // THE SERVED-MODEL LAW (the opt-in refusal fallback, never a silent
  // substitute): the model that SERVES the turn, when it is not the one
  // requested, is stamped on every assistant message minted from here on
  // (`model`) and named on the pulse byline. Learned from message_start (a
  // pre-output decline, or sticky routing) or from a `fallback` content
  // block (a mid-output decline). Compared by canonical family so a dated
  // snapshot of the requested alias never reads as a substitute.
  const requestedWire = normalizeModelStringForAPI(options.model)
  let servedModel: string | undefined
  // Whether the serving model ran the WHOLE turn: learned at message_start
  // (a pre-output decline, or sticky routing) the rescue is billed at the
  // serving model's own rates and nothing at the requested model's. A
  // mid-output handover (a `fallback` block) leaves the streamed partial on
  // the requested model's bill, so that turn keeps the requested model's
  // rates — the conservative price, never an understated one.
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
  /** The model whose rates price (and whose usage row records) this turn:
   *  the serving model when it ran the whole turn, else the requested one. */
  const pricingModel = (): string =>
    servedModel && servedWholeTurn ? servedModel : resolvedModel
  let stopReason: BetaStopReason | null = null
  // True once THIS attempt's usage joined the session ledger (the
  // message_delta pricing, or the exit settlement below) — the
  // exactly-once guard of the ledger-every-exit law.
  let ledgerSettled = false
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let isAdvisorInProgress = false
  // The pre-first-event watchdog rung spends at most ONE streaming reissue
  // per call before the non-streaming recovery of last resort.
  let preFirstEventStreamRetryUsed = false

  /** One assistant envelope per completed block (streaming) or per
   *  fallback response — the single mint for all three sites. */
  const mintAssistantMessage = (
    base: BetaMessage,
    blocks: BetaContentBlock[],
  ): AssistantMessage => ({
    message: {
      ...base,
      // The served-model law: a fallback model's output carries its name.
      ...(servedModel && { model: servedModel }),
      content: normalizeContentFromAPI(blocks, tools, options.agentId),
    },
    requestId: streamRequestId ?? undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    ...(advisorModel && { advisorModel }),
  })

  /** THE ABORT-PARTIAL LAW: a user Esc mid-stream
   *  must not erase the words the operator watched stream — the in-flight
   *  TEXT blocks (never a half-parsed tool_use, never unsigned thinking:
   *  both are replay poison on the next request) mint as one final
   *  assistant message before the quiet abort return, so the transcript,
   *  the durable record, and the next turn's history keep the partial.
   *  query.ts still owns the interruption row that follows it. */
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

  /** THE LEDGER-EVERY-EXIT LAW (FN-018 ranks 1 + 5): a request that
   *  reached message_start was billed — its prefill in full, plus whatever
   *  output streamed — and joins the session ledger exactly once on EVERY
   *  exit: the operator's Esc (the abort exit), a mid-stream death that
   *  routes to the non-streaming fallback (a second, separately billed
   *  request whose usage used to REPLACE the first's), an error exit, or
   *  the consumer's early return. The message_delta path settles the clean
   *  case and marks it; every other exit settles here. Output tokens are
   *  the wire's count when a delta carried one; before the delta the start
   *  frame reports 1, so the streamed text and thinking are estimated at
   *  the one character-ratio owner instead — never zero for words the
   *  operator watched arrive. Pinned by prove-ledger-every-exit. */
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
    // The served-model law composes with the ledger-every-exit law: an
    // aborted or faulted attempt is priced and recorded at the model that
    // served it (learned at message_start), exactly as the clean path is.
    addToTotalSessionCost(
      calculateUSDCost(pricingModel(), settled),
      settled,
      pricingModel(),
    )
  }

  /** Unwrap a retry-exhausted error and log the failure with full request
   *  correlation. Returns the unwrapped error + the model it failed on. */
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
    // Streaming passes: pass 1 always; pass 2 ONLY after a pre-first-event
    // watchdog abort (zero events were consumed, so a reissued stream is
    // invisible to the consumer). Every other exit — success, the
    // non-streaming fallback, or a thrown error — leaves after one pass.
    // The body keeps its pre-loop indentation: it is the whole streaming
    // attempt, and re-indenting ~600 lines would bury the actual change.
    // biome-ignore lint/plugin: the loop wraps the original single-pass body
    streamingPass: for (;;) {
    if (pulseMain) pulseStageStart('client_setup')
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // retries are owned here, not by the SDK
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        start = Date.now()
        // The client exists once this callback runs; withRetry re-creates
        // it only after auth errors, so attempt 1's delta from
        // client_creation_start is the meaningful one.
        if (pulseMain) pulseStageEnd('client_setup')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource) // bug-report capture

        // Cache-break phase 1: snapshot THIS attempt's wire
        // prompt state so phase 2 can explain a real cache-read drop.
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

        // These marks MUST precede the awaited call: .withResponse()
        // resolves only when response headers arrive, and the dispatch
        // boundary is the moment local preparation ends and the provider
        // wait begins. Retries re-mark honestly; summaries read the first
        // stamp.
        if (pulseMain) {
          pulseMark('api_request_sent')
          setPulsePhase(getActivePulseTrace()?.generation ?? 0, 'waiting')
        }
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
          notePrintPhase('dispatch')
        }

        // A client-generated request id correlates timeouts (which carry
        // no server id) with server logs. First-party only — third-party
        // gateways don't log the header (inc-4029 class).
        clientRequestId = isFirstPartyAnthropicBaseUrl() ? randomUUID() : undefined

        // Raw stream, NOT BetaMessageStream: that wrapper partial-parses
        // JSON on every input_json_delta — O(n²) over large tool inputs —
        // and this loop accumulates tool input itself.
        // biome-ignore lint/plugin: attribution for the main loop rides the fingerprint header
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        if (pulseMain) pulseMark('response_headers_received')
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

    // Pump: retry-notice system messages pass through; the stream itself
    // is the return value (it owns a controller, notices don't).
    let e
    do {
      e = await generator.next()
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent>

    // A retried attempt starts clean — after the abandoned one settled
    // whatever it was billed for (a no-op when no message_start arrived,
    // the only shape the reissue rung admits).
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

    // Idle watchdog: always on, default 90s (env-tunable with a 1s floor —
    // slow links raise it, provers shrink it). The SDK's request
    // timeout covers only the initial fetch — a connection dropped
    // MID-stream otherwise wedges the turn until the operator presses ESC.
    // Unlike the stall accounting below (which observes only when the next
    // chunk finally lands), the timer actively kills the stream. The budget
    // and its warning half have ONE owner (providers/streamIdleBudget): the
    // runner reports the same number in its facts answer, and the focused
    // chat's status row says "stuck" against it, never a second constant.
    const STREAM_IDLE_TIMEOUT_MS = streamIdleTimeoutMs()
    const STREAM_IDLE_WARNING_MS = streamIdleWarningMsOf(STREAM_IDLE_TIMEOUT_MS)
    let streamIdleAborted = false
    // Flips once a LOCAL tool_use block completes (content_block_stop):
    // the consumer executes streamed tools as they arrive, so from that
    // point a watchdog abort must NOT reach the non-streaming fallback —
    // re-issuing the request would run the same Bash/Write/Edit twice
    // (inc-4258). A PRE-tool stall (the watchdog's common case) still
    // falls back and recovers.
    let streamedToolUse = false
    // The watchdog's cause discriminator: pre-first-event silence (headers
    // arrived, zero SSE events — server-side ingest or a dead connection)
    // is a different failure than mid-stream silence, and gets a different
    // retry posture. Both only ever grow; the catch reads them after abort.
    let sawFirstStreamEvent = false
    let streamEventCount = 0
    // performance.now() at watchdog fire — measures abort propagation.
    let streamWatchdogFiredAt: number | null = null
    // ONE lazy deadline timer serves both thresholds. The per-event work is
    // a single timestamp write; the timer is aimed at the next deadline of
    // the CURRENT silence window and, on firing, re-aims if events moved it
    // — where the previous shape cleared and recreated two setTimeouts per
    // SSE event (thousands of timer ops per reply). Semantics preserved:
    // the warning fires once per contiguous silence window at half budget,
    // the abort at the full budget, and a new event re-arms both.
    let lastStreamEventAtMs = 0
    // The lastStreamEventAtMs value the warning already fired for — a later
    // event moves the stamp forward, making the next window warn-eligible.
    let idleWarnedForMs = -1
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    function clearStreamIdleTimers(): void {
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    function onStreamIdleDeadline(): void {
      streamIdleTimer = null
      const silentMs = Date.now() - lastStreamEventAtMs
      if (silentMs >= STREAM_IDLE_TIMEOUT_MS) {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `stream silent for ${STREAM_IDLE_TIMEOUT_MS / 1000}s — watchdog aborting the stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        releaseStreamResources()
        return // aborted — the watchdog stands down
      }
      if (
        silentMs >= STREAM_IDLE_WARNING_MS &&
        idleWarnedForMs !== lastStreamEventAtMs
      ) {
        idleWarnedForMs = lastStreamEventAtMs
        logForDebugging(
          `stream silent for ${STREAM_IDLE_WARNING_MS / 1000}s — watchdog warning`,
          { level: 'warn' },
        )
        logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
      }
      armStreamIdleWatchdog()
    }
    function armStreamIdleWatchdog(): void {
      const nextDeadlineAt =
        lastStreamEventAtMs +
        (idleWarnedForMs === lastStreamEventAtMs
          ? STREAM_IDLE_TIMEOUT_MS
          : STREAM_IDLE_WARNING_MS)
      streamIdleTimer = setTimeout(
        onStreamIdleDeadline,
        Math.max(0, nextDeadlineAt - Date.now()),
      )
    }
    lastStreamEventAtMs = Date.now()
    armStreamIdleWatchdog()

    startSessionActivity('api_call')
    try {
      let isFirstChunk = true
      let lastEventTime: number | null = null // null until chunk 1 — TTFB is not a stall
      const STALL_THRESHOLD_MS = 30_000
      let totalStallTime = 0
      let stallCount = 0

      for await (const part of stream) {
        lastStreamEventAtMs = Date.now()
        sawFirstStreamEvent = true
        streamEventCount++
        const now = Date.now()

        // Stall accounting: gaps between events, first chunk excluded.
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
            // A pre-output refusal fallback (or sticky routing) names the
            // serving model here already.
            noteServedModel(part.message?.model, 'start')
            break
          }
          case 'content_block_start':
            // A frame whose type promises a body it does not carry is a
            // wire-shape violation (a gateway answering in another vendor's
            // frame layout): the typed sentence names the frame and what was
            // expected — a bare `part.content_block.type` here threw the raw
            // "Cannot read properties of undefined (reading 'type')" that one
            // console ask painted as its reply (the answer-seam sighting).
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
                  // The SDK sometimes pre-fills text at block start AND
                  // re-sends the same text as a delta, with no way to tell
                  // a duplicate from a legitimate delta — so the start
                  // text is discarded and deltas are the single source.
                  text: '',
                }
                break
              case 'thinking':
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // Same duplication hazard as text.
                  thinking: '',
                  // Present even if no signature_delta ever arrives.
                  signature: '',
                }
                break
              default:
                // The SDK mutates its own block objects as it parses;
                // copying here keeps OUR accumulation immutable.
                contentBlocks[part.index] = { ...part.content_block }
                // A `fallback` block (the opt-in refusal fallback, a
                // mid-output decline): the model that continues is named.
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
            // Same wire-shape law as content_block_start: a delta frame
            // without its delta body is undecodable — say so typed.
            if (delta == null) {
              throw new Error(malformedStreamFrameText('content_block_delta', 'delta'))
            }
            switch (delta.type) {
              case 'citations_delta':
                // Citations are not consumed anywhere downstream yet.
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
              // From here the consumer is (or will be) executing this
              // tool — the watchdog→fallback guard reads this flag.
              streamedToolUse = true
            }
            newMessages.push(m)
            yield m
            break
          }
          case 'message_delta': {
            // The frame's own body law (see content_block_start above): a
            // message_delta without its delta cannot settle a stop_reason.
            if (part.delta == null) {
              throw new Error(malformedStreamFrameText('message_delta', 'delta'))
            }
            usage = updateUsage(usage, part.usage)

            // The final usage/stop_reason write back onto the LAST yielded
            // message: it was minted from partialMessage, whose usage was
            // captured at message_start (output_tokens 0, stop_reason
            // null) — message_delta is where the real values arrive.
            //
            // Property mutation on purpose: every in-memory holder of the
            // reference (UI rows, the run loop) sees the update. The
            // DURABLE record settles EXPLICITLY below — the write queue
            // serialized at enqueue, so there is no lazy
            // window for this mutation to ride.
            stopReason = part.delta.stop_reason

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              // Boundary cast: the legacy core message type still spells
              // usage the provider way until its IDM-12 retirement; the
              // public NonNullableUsage is Mercury-owned (IDM-10).
              lastMsg.message.usage = usage as AssistantMessage['message']['usage']
              lastMsg.message.stop_reason = stopReason
              void settleTranscriptMessage(lastMsg)
            }

            // The served-model law reaches the bill: a whole-turn rescue is
            // priced and recorded at the serving model, never the requested.
            const costUSDForPart = calculateUSDCost(pricingModel(), usage)
            addToTotalSessionCost(costUSDForPart, usage, pricingModel())
            ledgerSettled = true

            // Cache-break phase 2: settled usage says whether
            // the server cache really broke. Fire-and-forget — never
            // blocks the stream path.
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
              // Same recovery contract as max_tokens: the response was cut
              // off; continue from where it stopped.
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'message_stop':
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // The loop exited on its own — stand the watchdog down.
      clearStreamIdleTimers()

      // A watchdog abort that ended the loop CLEANLY still needs the
      // fallback path — route it through the catch below.
      if (streamIdleAborted) {
        // Probe: the for-await did exit after the watchdog (vs hanging),
        // and how long propagation took — 0-10ms means the abort worked;
        // ≫1000ms means something else woke the loop.
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
        // Null the stamp so the catch path's probe doesn't double-fire.
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // A "complete" stream that produced nothing is a proxy failure:
      //   1. no events at all (!partialMessage) — 200 with a non-SSE body;
      //   2. message_start but neither a completed block NOR a stop_reason
      //      — the stream died mid-message.
      // The raw Stream (unlike BetaMessageStream's _endRequest) does not
      // self-check, and silently returning nothing surfaces as "Execution
      // error" in -p mode. stopReason matters for the false-positive:
      // structured output legitimately ends turn 2 with end_turn and zero
      // content blocks.
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'stream closed before message_start — routing to the non-streaming fallback'
            : 'stream closed after message_start with no completed block and no stop_reason — routing to the non-streaming fallback',
          { level: 'error' },
        )
        throw new Error('Stream ended without receiving any events')
      }

      if (stallCount > 0) {
        logForDebugging(
          `stream finished carrying ${stallCount} stall(s), ${(totalStallTime / 1000).toFixed(1)}s stalled in total`,
          { level: 'warn' },
        )
      }

      // Mercury Cache Clock meter tap: shape-only
      // usage counts feeding the session rollup and the live all-5m
      // counterfactual. Flag-gated and fail-open inside.
      cacheClockObserve({
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTotal: usage.cache_creation_input_tokens,
        cacheCreation5m: usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
        cacheCreation1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
        uncachedInputTokens: usage.input_tokens,
        now: Date.now(),
      })

      // Quota headers ride the streaming Response. (TS control flow can't
      // see the withRetry callback assigned streamResponse.)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
      }
    } catch (streamingError) {
      clearStreamIdleTimers()

      // Probe: the watchdog fired and the loop exited via THROW — with the
      // same propagation measurement as the clean-exit probe.
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

      if (streamingError instanceof APIUserAbortError) {
        // The SDK spells both shapes APIUserAbortError; OUR signal is the
        // discriminator. Aborted signal = the operator pressed ESC.
        if (signal.aborted) {
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          if (isAdvisorInProgress) {
            logForDebugging('[AdvisorTool] user abort landed mid-advisor-call')
          }
          throw streamingError
        } else {
          // Unaborted signal = the SDK's own internal timeout.
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      // The fallback gate. Three vetoes, all propagating the error to
      // withRetry instead:
      //   - the env kill-switch / the feature gate (a mid-stream fallback
      //     re-produces any already-executing tool_use — inc-4258);
      // a watchdog abort AFTER a local tool_use streamed (
      //     follow-up): the consumer already started that tool's side
      //     effect, and the fallback would run the SAME Bash/Write/Edit
      //     again. A safe-but-errored turn beats a duplicate
      //     non-idempotent tool. Deliberately gated on streamedToolUse —
      //     a PRE-tool watchdog abort (the common case: connection died
      //     mid-text) has nothing to double-run and MUST still recover.
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

      // Per-cause posture, pre-first-event: the watchdog fired with ZERO
      // events consumed, so a second STREAMING attempt is invisible to the
      // consumer and keeps the interactive seat live — first tokens paint
      // as they arrive, where the blocking fallback would sit silent for
      // its whole budget. The common shape is a switched or uncached
      // prompt whose server-side ingest outran the budget; that first
      // attempt also warmed the prompt cache, so the reissue is cheaper.
      // ONE rung: a second pre-event silence falls through to the
      // non-streaming recovery of last resort.
      if (
        streamIdleAborted &&
        !sawFirstStreamEvent &&
        !preFirstEventStreamRetryUsed
      ) {
        preFirstEventStreamRetryUsed = true
        // The reissue must not ride the pool that just parked: a
        // pre-first-event stall is indistinguishable from a half-dead
        // pooled socket, and the next pass builds a fresh client whose
        // fetchOptions re-read the (now dropped) dispatcher — a fresh
        // connection either recovers outright or converts the theory into
        // a second silence that reaches the fallback below. Costs one TLS
        // handshake on a false alarm, nothing more.
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
      // A watchdog-aborted stream (pre-first-event twice, or mid-stream
      // silence) is connection-suspect: the fallback's own client build
      // must not inherit the parked pool — same recovery law as the
      // reissue above.
      if (streamIdleAborted) resetApiConnectionPool()
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback()
      }
      // LIVENESS: the blocking fallback call can emit nothing for its full
      // timeout — a silent window outer no-progress watchdogs read as a
      // wedge and kill mid-recovery. The recovery notice goes out BEFORE
      // blocking so budget consumers can extend. retryInMs is real (0 —
      // the fallback starts now); the ceiling rides recoveryTimeoutMs so
      // no renderer fakes a countdown. A watchdog abort names its actual
      // threshold AND its cause — pre-first-event silence (server-side
      // ingest or a dead connection, persisted across a reissued stream)
      // reads differently from a mid-stream drop, and the operator deserves
      // to know which one ate the wait.
      // Recovery honesty: the blocking fallback shows no tokens while it
      // waits, so the notice says exactly what it is waiting on and for how
      // long — a silent 69s made an operator kill a working recovery
      // (the wedge).
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

      // A 529 that killed the stream counts toward the consecutive-529
      // budget, so total 529s-before-model-fallback is mode-independent.
      // Probe: proves the request was ENTERED (vs the notice firing and
      // the call hanging at dispatch).
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      const result = yield* executeNonStreamingRequest(
        // The fallback rides the SAME fetch seam the stream rode (a prover's
        // fixture must never reach a live host on the recovery road).
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
      )

      // A non-streaming response names its serving model directly; a
      // `fallback` block inside it marks a mid-output handover.
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
    // Normal completion (streamed or via the non-streaming fallback):
    // exactly one pass. Only the pre-first-event `continue` above repeats.
    break
    }
    settledNormally = true
  } catch (errorFromRetry) {
    // The model-fallback signal belongs to query.ts, which performs the
    // actual switch. Swallowing it here would reduce the fallback to an
    // error message with no retry behind it.
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // Gateways that 404 the streaming endpoint while serving non-streaming
    // fine: with raw streams the 404 surfaces at CREATION (this catch),
    // where older stream wrappers threw it during iteration (the inner
    // catch). CannotRetryError + status 404 + no fallback yet = that case.
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // The 404 threw before streamRequestId was ever assigned; the failed
      // request's id lives on the error.
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
      // Same LIVENESS contract as the stream-error fallback: real 0 delay,
      // ceiling in its own field.
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

        // A non-streaming response names its serving model directly; a
        // `fallback` block inside it marks a mid-output handover.
        noteServedModel(
          result.model,
          result.content.some(b => (b.type as string) === 'fallback') ? 'block' : 'start',
        )
        const m = mintAssistantMessage(result, result.content)
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // fall through to the success bookkeeping below
      } catch (fallbackError) {
        // Same propagation rule as above.
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

      // User aborts end quietly (the in-flight partial minted first — the
      // abort-partial law) — query.ts owns the interruption message.
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
    // MUST live in finally: a consumer that breaks its for-await (or an
    // abort in query.ts) terminates this generator via .return(), and no
    // code after the try runs. Without the release here, the Response's
    // native buffers leak until the generator itself is collected
    // (GH #32920).
    releaseStreamResources()

    // Every exit that never reached the message_delta pricing settles the
    // attempt's usage HERE, before the fallback fold below can replace it
    // (the ledger-every-exit law; a no-op once settled).
    settleUnpricedAttempt()
    // …and its API duration: an abort, an error past the retry ladder or
    // the consumer's early return spent real provider time (the success
    // tail writes it for the settled case, with its success marks).
    if (!settledNormally) logAPIDuration({ start, startIncludingRetries })

    // Fallback cost lands here, not at yield: the streaming path prices
    // inside message_delta BEFORE yielding, but the fallback yields its
    // message and a .return() at that yield would skip any tracking after
    // it. The finally always runs.
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      // Leaf concretization: fallback usage arrives wire-shaped;
      // updateUsage folds it onto the concrete Mercury contract.
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

  // The shutdown cache-eviction hint follows the MAIN chain's last request
  // id. Backgrounded sessions (Ctrl+B) share the repl_main_thread source
  // but run inside an agent context — independent chains whose cache must
  // survive the foreground session's exit.
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

  // Belt over the finally's braces: releasing twice is a no-op.
  releaseStreamResources()
}

type SmallFastOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

/**
 * One-shot prompt against the SESSION FAMILY's small-fast tier —
 * classifier-class calls: no tools, no thinking, caching off unless asked.
 * The routing law decides the family and the family's recorded fact decides
 * the tier (sessionSmallFastModel), so a non-Anthropic session's utility
 * calls ride its own wire and wallet — never a silent Anthropic hop.
 * Non-streaming, so the single result message is the whole story.
 */
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

/**
 * One-shot prompt against a CALLER-CHOSEN model, through the full request
 * pipeline — real auth, betas, headers — rather than a bare API call.
 * The model id decides the wire: non-anthropic ids run on their own
 * provider runtime (the routed callModel seam, late-imported to keep this
 * core free of the provider graph), whose account refusals stay the honest
 * surface — an id must never fall through to another provider.
 */
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

      // MULTI-AUTH-NATIVE settlement fold — settleAssistantTurn is the one
      // owner (callModelRouter, shared with routedCallModelSettled); the
      // rationale lives on the fold itself.
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

// The API caps non-streaming requests at ten minutes. The SDK derives a
// 21,333-token ceiling from that; the client-level timeout set above
// bypasses the SDK's derivation, so the cap here can sit higher.
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * Re-fit params for the capped non-streaming path while preserving the
 * API's invariant max_tokens > thinking.budget_tokens.
 */
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
        cappedMaxTokens - 1, // strictly below max_tokens
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

function isMaxTokensCapEnabled(): boolean {
  // Defaults false — flipped only by the feature slot.
  return getFeatureValue_CACHED_MAY_BE_STALE('mercury_otk_slot_v1', false)
}

/**
 * The output-token ceiling for a model: the slot-reservation cap (p99
 * output is ~5K tokens; 32-64K defaults over-reserve slot capacity 8-16×,
 * and a capped request gets one clean 64K retry upstream), floored by the
 * model's own native default, then the operator env override — which wins
 * within the model's hard upper limit.
 */
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
