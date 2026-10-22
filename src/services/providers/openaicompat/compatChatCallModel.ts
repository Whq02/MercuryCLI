import { settleTranscriptMessage } from '../../../utils/sessionStorage/writer.js'
import { processOwnerForLane } from '../../run/resolveOwner.js'
import { createHash, randomUUID } from 'crypto'
import { getSessionId } from '../../../bootstrap/state.js'
import { compatEngineRefusalText } from './compatRefusals.js'
import { compatToolSchemaRefusal, firstCompatToolRefusal } from './compatToolSchemas.js'
import { getCwd } from '../../../utils/cwd.js'
import { mintCacheDomainKey } from '../../../utils/cache/cacheDomain.js'
import type {
  ApiContentBlockDelta,
  ApiMessage,
  ApiStreamEvent,
  ContentBlock,
  MessageParam,
} from '../../../types/wire.js'
import type { Tools } from '../../../Tool.js'
import type {
  AssistantMessage,
  BusyRefusalV1,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { API_ERROR_MESSAGE_PREFIX, streamFaultAfterPartialText } from '../../api/errors.js'
import { coldPrefixOf, estimateRequestTokens, measuredPrefillMs, retryNoticeWait, retryReasonWords, requestWaitLine, silentAfterHeadersWindowMs, streamIdleTimeoutMsForRoute, streamReconnectSpentLine, streamReconnectWait, typedStreamEndOf } from '../streamIdleBudget.js'
import { providerWaitIsWindow, retrySeconds, stampProviderWait } from '../../api/recoveryBudget.js'
import { markUnknownModel } from '../../api/backupEngines.js'
import { NetworkOutageError, nextReconnect, openReconnectLadder, ReconnectBudgetSpentError, streamReconnectCause, type ReconnectLadder } from '../../api/reconnectLadder.js'
import { patienceSeconds } from '../patience.js'
import { createSystemAPIErrorMessage } from '../../../utils/messages/systemMessages.js'
import { sleep } from '../../../utils/sleep.js'
import { busyRecoveryDetail, busyRefusalFact, heldBusyRetryWait, nextBusyRetry, openBusyRetryLadder, takesBusyLadder, type BusyRetryLadder } from '../busyRetry.js'
import { EMPTY_STREAM_TRIES, emptyStreamRetryNotice, emptyStreamRetryWaitMs, emptyStreamSpentWords, isEmptyStreamFault } from '../emptyStreamRetry.js'
import { isTemporaryStreamFault } from '../temporaryStreamError.js'
import { getPublicModelDisplayName } from '../../../utils/model/model.js'
import { classifyOverflowFault, type OverflowSignal } from '../../api/overflowSignal.js'
import { fitOutputTokensForRequest, outputFitWords } from '../../api/outputFit.js'
import { EMPTY_USAGE } from '../../api/emptyUsage.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  type CacheLane,
  type NeutralToolSchema,
} from '../../api/promptCacheBreakDetection.js'
import type { Options } from '../anthropic/streamCore.js'
import {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from '../anthropic/messageParams.js'
import { toolToAPISchema } from '../../../utils/api.js'
import {
  createAssistantAPIErrorMessage,
  healWalkableForWire,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import { resolveEffortTruth, resolveWireRequestedEffort } from '../../../utils/effort.js'
import { effortStampOf, type EffortStampV1, type EffortWireFact } from '../../../utils/effortStamp.js'
import { compatEffortWireFact, thinkingOffWireEffort } from './compatWire.js'
import { isKimiK3WireModel, kimiReplayProjection, replayKimiHistory } from './kimiReplay.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import { operatorModelFacts } from '../../../utils/model/modelOverrides.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { captureSignInRequest, observeSignInResponse } from '../../../utils/accounts/signInRefusal.js'
import { classifyCredentialWall, credentialWallLine } from '../credentialWall.js'
import { logForDebugging } from '../../../utils/debug.js'
import { canonicalWireModelId } from '../routeLaw.js'
import {
  renderGenericInstructions,
  resolveBehaviourContract,
  stableBehaviourDigest,
} from '../../../prompt/behaviourContract.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { estimateFaultedRequestUsage } from '../faultUsageEstimate.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'
import { imageRefusalWords, mapMessagesToZai, mapToolsToZai, toolDeclarationRowAsText, type ApiShapedTool, type ToolDeclarationRowBuilder } from '../zai/zaiCodec.js'
import type { ZaiWireMessage } from '../zai/zaiClient.js'
import { effortVocabularyFor, getContextWindowForModel, getModelMaxOutputTokens, modelReceivesImageBlocks } from '../../../utils/model/capabilities.js'
import { imageRefusalOf, noteImageRefusal } from '../../desktop/desktopSession.js'
import { compatImageRefusalWords, compatModelImageReading, refreshCompatModelImageReading } from './compatProbe.js'
import type { MediaRefusal } from '../../api/mediaRefusal.js'
import {
  streamCompatChat,
  type CompatChatRequest,
  type CompatCompletedToolCall,
  type CompatDeferralFacts,
  type CompatFault,
  type CompatFinishReason,
  type CompatLivenessReading,
  type CompatStreamEvent,
  type CompatStreamOptions,
  type CompatUsage,
} from './compatChatClient.js'
import type { RefusedToolCall } from '../../../types/message.js'
import { gateToolCalls, toolCallRefusalDiagnostic, toolCallRefusalNote } from '../toolCallGate.js'
import { isLocalLivenessCut, localStreamLawFor } from '../localLiveness.js'
import { extractToolCallMarkup } from '../local/toolCallMarkup.js'
import { renderToolDialectHistory, toolDialectSystemText } from '../local/toolDialect.js'
import { planToolPayload, renderAdmissionRecordsAsText, type ToolPayloadPlan } from '../toolEconomy.js'
import { retireOlderScreenshots } from '../../desktop/screenshotRetention.js'
import { fitImagesToRequestCap } from '../../../utils/imageResizer.js'
import { stripThinkingFromIndex } from '../../../utils/messages/apiFilters.js'

const COMPAT_MAX_ATTEMPTS = 2
const COMPAT_RETRY_BACKOFF_MS = 400

type CompatLaneId =
  | 'moonshot'
  | 'deepseek'
  | 'xai'
  | 'meta'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'
  | 'mistral'
  | 'nous'
  | 'zen'
  | 'minimax'
  | 'together'
  | 'cohere'
  | 'groq'
  | 'cerebras'
  | 'fireworks'
  | 'qwen'

export function imagesSupportedForCompatModel(model: string): boolean {
  const reading = compatModelImageReading(model)
  return reading !== undefined ? reading.supported : modelReceivesImageBlocks(model) && imageRefusalOf(model) === null
}

export function compatDispatchModelId(model: string): string {
  return normalizeModelStringForAPI(model.trim())
}

interface CompatCredential {
  apiKey?: string
  requestUrl?: string
  accountIdentity?: string
}

export interface CompatLaneProfile {
  lane: CompatLaneId
  dialect?: string
  prefillTokensPerSecond?(): Promise<number | undefined>
  liveness?(pinnedSlot: number | undefined): Promise<CompatLivenessReading>
  streamTransport?(options: CompatStreamOptions, messages: readonly Message[]): {
    events: AsyncGenerator<CompatStreamEvent>
    settle?(messages: readonly AssistantMessage[]): void
  } | undefined
  effortOnWire?(extra: Record<string, unknown>): EffortWireFact
  usageForSettlement?(usage: CompatUsage): CompatUsage
  policyFaultNote?(fault: CompatFault, extra: Record<string, unknown> | undefined): string | undefined
  leadingNotes?: readonly string[]
  providerLabel: string
  resolveCredential(): CompatCredential | undefined | Promise<CompatCredential | undefined>
  credentialHint: string
  authRemedy?: string
  billingRemedy?: string
  recoverCredential?(): Promise<CompatCredential | undefined | null>
  requestUrl(): string
  wireModelId(modelId: string): string
  requestFitRefusal?(estimate: { requestBytes: number; estTokens: number; toolCount: number; wireModel: string }): string | undefined
  servedWindowTokens?(): number | undefined
  onResponseHeaders?(headers: Headers, status?: number): void
  onCredentialRefused?(fault: Pick<CompatFault, 'status' | 'code' | 'message'>): void
  extraHeaders?(): Record<string, string> | undefined
  omitsToolChoice?: boolean
  toolCapabilityRefusal?(wireModel: string): string | undefined
  toolsInPrompt?(wireModel: string): boolean
  buildExtras(args: {
    wireModel: string
    effortValue: string | undefined
    thinkingEnabled: boolean
    maxOutputTokensOverride: number | undefined
    conversationKey?: string
    cacheDomainKey?: string
    crewmate?: boolean
  }): Record<string, unknown>
  keepsReasoningHistory?(wireModel: string): boolean
  keepsReasoningOnContinuations?(wireModel: string): boolean
  noteServedModel?(requested: string, served: string, credential: CompatCredential): void
  toolDeclarationRow?: ToolDeclarationRowBuilder
}

const liveProof = new Map<CompatLaneId, { at: number; model: string }>()
export function compatLaneLiveProofState(lane: CompatLaneId): { at: number; model: string } | null {
  return liveProof.get(lane) ?? null
}

export interface CompatCallModelParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}

function apiErrorMessage(
  content: string,
  error: NonNullable<AssistantMessage['error']> = 'unknown',
  errorDetails?: string,
  overflow?: OverflowSignal | null,
  busyRefusal?: BusyRefusalV1 | null,
  mediaRefusal?: MediaRefusal | null,
): AssistantMessage {
  return createAssistantAPIErrorMessage({
    content,
    error,
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
    ...(busyRefusal !== undefined ? { busyRefusal } : {}),
    ...(mediaRefusal !== undefined ? { mediaRefusal } : {}),
  })
}

function overflowOf(
  profile: Pick<CompatLaneProfile, 'lane' | 'servedWindowTokens'>,
  fault: Pick<CompatFault, 'code' | 'message'> & { status?: number },
  sent: { request: CompatChatRequest; model: string },
): OverflowSignal | null {
  return classifyOverflowFault({
    family: profile.lane,
    status: fault.status,
    code: fault.code,
    message: fault.message,
    measured: () => ({
      tokens: estimateRequestTokens(sent.request),
      window: profile.servedWindowTokens?.() ?? getContextWindowForModel(sent.model),
    }),
  })
}

type TypedError = NonNullable<AssistantMessage['error']>

const GOOGLE_STATUS_CLASS: Record<string, TypedError> = {
  UNAUTHENTICATED: 'authentication_failed',
  PERMISSION_DENIED: 'authentication_failed',
  RESOURCE_EXHAUSTED: 'rate_limit',
  INVALID_ARGUMENT: 'invalid_request',
  FAILED_PRECONDITION: 'invalid_request',
  NOT_FOUND: 'invalid_request',
  UNAVAILABLE: 'server_error',
  INTERNAL: 'server_error',
  DEADLINE_EXCEEDED: 'server_error',
}

function zaiCodeClass(code: number): TypedError | undefined {
  if (code >= 1000 && code <= 1005) return 'authentication_failed'
  if (code === 1113) return 'billing_error'
  if (code === 1302 || code === 1305) return 'rate_limit'
  if (code === 1211 || code === 1301) return 'invalid_request'
  return undefined
}

const ZEN_BILLING_WORDS = /^(?:api|openai)-(?:CreditsError|MonthlyLimitError|UserLimitError)$/

function minimaxCodeClass(code: number): TypedError | undefined {
  if (code === 1004 || code === 2049) return 'authentication_failed'
  if (code === 1008) return 'billing_error'
  if (code === 1002 || code === 1039 || code === 1041 || code === 2045 || code === 2056) return 'rate_limit'
  if (code === 2013 || code === 1026 || code === 1027 || code === 1042) return 'invalid_request'
  if (code === 1000 || code === 1001 || code === 1013 || code === 1024 || code === 1033) return 'server_error'
  return undefined
}

function vendorWordClass(code: string): TypedError | undefined {
  const zai = /^zai-(\d+)$/.exec(code)
  if (zai) return zaiCodeClass(Number(zai[1]))
  const minimax = /^minimax-(\d+)$/.exec(code)
  if (minimax) return minimaxCodeClass(Number(minimax[1]))
  if (ZEN_BILLING_WORDS.test(code)) return 'billing_error'
  if (!code.startsWith('api-')) return undefined
  const word = code.slice('api-'.length)
  const google = GOOGLE_STATUS_CLASS[word]
  if (google) return google
  if (/rate[-_]?limit|quota|exhausted/i.test(word)) return 'rate_limit'
  if (/insufficient[-_]?(credit|balance|fund)|billing|payment|balance|arrearage/i.test(word)) return 'billing_error'
  if (/auth|api[-_]?key|permission|forbidden/i.test(word)) return 'authentication_failed'
  if (/invalid|bad[-_]?request|not[-_]?found|unsupported|unprocessable/i.test(word)) {
    return 'invalid_request'
  }
  if (/overload|unavailable|server[-_]?error|internal|timeout/i.test(word)) return 'server_error'
  return undefined
}

export function compatFaultToTypedError(
  fault: Pick<CompatFault, 'code'> & { kind: string; status?: number },
): TypedError {
  const { kind, code, status } = fault
  const word = vendorWordClass(code)
  if (word === 'authentication_failed' || word === 'billing_error' || word === 'rate_limit') {
    return word
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'authentication_failed'
    if (status === 402) return 'billing_error'
    if (status === 429) return 'rate_limit'
    if (status === 408 || status >= 500) return 'server_error'
    if (status >= 400) return 'invalid_request'
  }
  if (word !== undefined) return word
  if (code === 'http-429') return 'rate_limit'
  if (/^http-40[13]$/.test(code)) return 'authentication_failed'
  if (code === 'http-402') return 'billing_error'
  if (/^http-4/.test(code)) return 'invalid_request'
  if (kind === 'cancelled') return 'unknown'
  return 'server_error'
}

export function compatTerminalFaultText(
  profile: Pick<CompatLaneProfile, 'providerLabel' | 'credentialHint' | 'authRemedy' | 'billingRemedy' | 'dialect'>,
  fault: Pick<CompatFault, 'code' | 'message' | 'parameter'> & { retryAfterMs?: number; status?: number },
  typed: TypedError,
  opts?: { recovery?: 'retried' | 'no-new-credential' },
): string {
  const detail = fault.message && fault.message !== '' ? `${fault.code}: ${fault.message}` : fault.code
  switch (typed) {
    case 'authentication_failed': {
      const recovery =
        opts?.recovery === 'retried'
          ? ' The stored token was refreshed and the call retried once before this refusal.'
          : opts?.recovery === 'no-new-credential'
            ? ' A token refresh was attempted first and produced no new credential.'
            : ''
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} rejected the credential (${detail}) — ${profile.authRemedy ?? profile.credentialHint}${recovery}`
    }
    case 'billing_error':
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} reports the account out of credit (${detail}) — ${profile.billingRemedy ?? 'top up the account at the provider, then retry; /model picks another model meanwhile.'}`
    case 'rate_limit': {
      const asked =
        fault.retryAfterMs !== undefined
          ? ` — the provider asks for a ${patienceSeconds(fault.retryAfterMs)} wait${providerWaitIsWindow(fault.retryAfterMs) ? ', past the retry budget: a dispatched crewmate pauses until then' : ''}`
          : ''
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} is rate-limiting this account (${detail})${asked} — retry in a moment, or /model picks another model meanwhile.`
    }
    default: {
      const refusal = compatEngineRefusalText(profile.dialect, fault)
      return refusal ? `${API_ERROR_MESSAGE_PREFIX}: ${refusal}` : `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} stream failed (${fault.code}) — ${fault.message}`
    }
  }
}

function toBridgeMessages(
  messages: Message[],
): MessageParam[] {
  const out: MessageParam[] = []
  for (const m of messages) {
    if (m.type === 'user') {
      out.push(userMessageToMessageParam(m, false, false))
    } else if (m.type === 'assistant') {
      out.push(assistantMessageToMessageParam(m, false, false))
    }
  }
  return out
}

async function buildApiShapedTools(
  tools: Tools,
  options: Options,
  model: string,
  conversationKey?: string,
  pool: Tools = tools,
  accept?: (tool: ApiShapedTool) => boolean,
): Promise<ApiShapedTool[]> {
  const schemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools: pool,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model,
        conversationKey,
      }),
    ),
  )
  const out: ApiShapedTool[] = []
  for (const schema of schemas) {
    const record = schema as { name?: string; description?: string; input_schema?: unknown }
    if (typeof record.name === 'string' && record.input_schema !== undefined) {
      const tool: ApiShapedTool = {
        name: record.name,
        ...(record.description ? { description: record.description } : {}),
        input_schema: record.input_schema,
      }
      if (!accept || accept(tool)) out.push(tool)
    }
  }
  return out
}

async function buildToolDeclarationRows(
  plan: ToolPayloadPlan,
  pool: Tools,
  options: Options,
  model: string,
  build: ToolDeclarationRowBuilder,
  accept?: (tool: ApiShapedTool) => boolean,
): Promise<{ rows: ReadonlyMap<string, ZaiWireMessage>; admitted: readonly ApiShapedTool[] }> {
  const rows = new Map<string, ZaiWireMessage>()
  const admitted: ApiShapedTool[] = []
  for (const declaration of plan.admissionDeclarations) {
    const shaped = await buildApiShapedTools(declaration.tools, options, model, plan.conversationKey, pool, accept)
    if (shaped.length > 0) rows.set(declaration.toolUseId, build(mapToolsToZai(shaped)))
    admitted.push(...shaped)
  }
  return { rows, admitted }
}

export function mapCompatUsageToAnthropic(usage: CompatUsage | undefined): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
    output_tokens_details: usage?.reasoningTokens !== undefined
      ? { thinking_tokens: usage.reasoningTokens }
      : null,
  }
}

const FINISH_TO_STOP: Record<CompatFinishReason, 'end_turn' | 'tool_use' | 'max_tokens'> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
  insufficient_system_resource: 'end_turn',
  network_error: 'end_turn',
  other: 'end_turn',
}

type AttemptOutcome =
  | { kind: 'done'; served?: string }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: CompatFault; retryEligible: boolean }

export async function* compatChatCallModel(
  profile: CompatLaneProfile,
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  if (signal.aborted) return
  const modelId = compatDispatchModelId(options.model)

  const wireVerdict = canonicalWireModelId(options.model)
  if (!wireVerdict.ok) {
    yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${wireVerdict.reason}`)
    return
  }
  if (profile.lane === 'openai-compat' && messages.some(message => message.type === 'user' && Array.isArray(message.message.content) && message.message.content.some(block =>
    block.type === 'image' || block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(part => part.type === 'image'),
  ))) await refreshCompatModelImageReading(modelId, signal)
  if (signal.aborted) return
  let credential = await profile.resolveCredential()
  if (credential === undefined) {
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${profile.credentialHint} Model '${modelId}' cannot run.`,
    )
    return
  }

  const plan = await planToolPayload({
    model: modelId,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    latchKey: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)),
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
  })
  const toolNotes: string[] = []
  const withheldTools = new Set<string>()
  const acceptTool = (tool: ApiShapedTool): boolean => {
    const refusal = compatToolSchemaRefusal(profile.dialect, tool)
    if (!refusal) return true
    withheldTools.add(tool.name)
    if (firstCompatToolRefusal(getSessionId(), `${profile.requestUrl()}:${modelId}`, refusal)) toolNotes.push(refusal)
    return false
  }
  const apiTools = await buildApiShapedTools(plan.roster, options, modelId, plan.conversationKey, plan.roster, acceptTool)
  const declared = await buildToolDeclarationRows(plan, tools, options, modelId, profile.toolDeclarationRow ?? toolDeclarationRowAsText, acceptTool)
  const toolDeclarations = declared.rows
  const callableTools = [...apiTools, ...declared.admitted].filter(tool => !plan.isDeferredUnadmitted(tool.name))
  const contract = resolveBehaviourContract([...systemPrompt])
  const systemText = renderGenericInstructions(contract)
  const wireModel = profile.wireModelId(modelId)
  const cacheDomainKey = mintCacheDomainKey({
    providerScope: profile.lane,
    servedModel: wireModel,
    projectPath: getCwd(),
    behaviorContractDigest: stableBehaviourDigest(contract),
    toolSchemaDigest: createHash('sha256')
      .update(JSON.stringify(apiTools.filter(tool => !plan.deferredNames.has(tool.name))))
      .digest('hex')
      .slice(0, 16),
  })
  const deferral: CompatDeferralFacts | undefined = plan.enabled
    ? {
        form: plan.wireForm,
        deferredNames: plan.deferredNames,
        ...(plan.conversationKey !== undefined ? { conversationKey: plan.conversationKey } : {}),
        cacheDomainKey,
        imagesSupported: imagesSupportedForCompatModel(modelId),
      }
    : undefined
  const wireMessages = renderAdmissionRecordsAsText(messages, plan.wireForm)
  const effortValue = resolveWireRequestedEffort(modelId, options.effortValue, { agentId: options.agentId })
  const effortTruth = resolveEffortTruth(modelId, options.effortValue, { agentId: options.agentId })
  const thinkingEnabled = thinkingConfig.type !== 'disabled'
  const toolsInPrompt = apiTools.length > 0 && profile.toolsInPrompt?.(wireModel) === true
  if (apiTools.length > 0 && !toolsInPrompt && profile.toolCapabilityRefusal) {
    const refusal = profile.toolCapabilityRefusal(wireModel)
    if (refusal !== undefined) {
      yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${refusal}`)
      return
    }
  }
  const retiredScreenshots = retireOlderScreenshots(wireMessages)
  const retiredMessages =
    retiredScreenshots.firstEdited === -1
      ? retiredScreenshots.messages
      : stripThinkingFromIndex(retiredScreenshots.messages, retiredScreenshots.firstEdited)
  const fittedImages = await fitImagesToRequestCap(retiredMessages, { model: modelId, owner: options.ownerKey ?? String(processOwnerForLane(options.agentId ?? null)) })
  const wireMessagesForBridge =
    fittedImages.firstEdited === -1
      ? fittedImages.messages
      : stripThinkingFromIndex(fittedImages.messages, fittedImages.firstEdited)
  const preparedMessages = healWalkableForWire(wireMessagesForBridge)
  const statedMaxOut = operatorModelFacts(modelId)?.maxOutputTokens !== undefined ? getModelMaxOutputTokens(modelId).default : undefined
  const askedOut = options.maxOutputTokensOverride !== undefined
    ? (statedMaxOut !== undefined ? Math.max(options.maxOutputTokensOverride, statedMaxOut) : options.maxOutputTokensOverride)
    : statedMaxOut
  const outputFit = askedOut === undefined
    ? undefined
    : fitOutputTokensForRequest({ asked: askedOut, messages, model: modelId, fixed: [systemText, apiTools] })
  if (outputFit?.clamped === true) logForDebugging(outputFitWords(outputFit, modelId))
  const fittedOutputOverride = outputFit?.tokens
  const wireTools = mapToolsToZai(apiTools)
  const mappedMessages = mapMessagesToZai(toolsInPrompt ? toolDialectSystemText(systemText, wireTools) : systemText, toBridgeMessages(preparedMessages), {
    keepReasoningHistory: profile.keepsReasoningHistory?.(wireModel) ?? false,
    keepReasoningAfterLastUser: profile.keepsReasoningOnContinuations?.(wireModel) ?? false,
    imagesSupported: imagesSupportedForCompatModel(modelId),
    ...(toolDeclarations.size > 0 ? { toolDeclarations } : {}),
  })
  const effortView = effortVocabularyFor(modelId)
  const operatorEffort =
    effortView.kind === 'provider' && effortView.source === 'operator' && effortView.vocabulary.length > 0
      ? !thinkingEnabled && effortView.thinkingGated
        ? thinkingOffWireEffort(effortView.vocabulary)
        : effortValue !== undefined
          ? effortView.vocabulary.includes(effortValue)
            ? effortValue
            : nearestSupportedWireEffort(effortValue, effortView.vocabulary)
          : undefined
      : undefined
  const slotKey = plan.conversationKey ?? cacheDomainKey
  const makeRequestExtra = (): Record<string, unknown> => {
    const builtExtras = profile.buildExtras({
      wireModel,
      effortValue,
      thinkingEnabled,
      maxOutputTokensOverride: fittedOutputOverride,
      conversationKey: slotKey,
      cacheDomainKey,
      crewmate: options.agentId !== undefined,
    })
    const extra = {
      ...(profile.lane !== 'openai-compat' && operatorEffort !== undefined && builtExtras.reasoning_effort === undefined && builtExtras.reasoning === undefined
        ? { ...builtExtras, reasoning_effort: operatorEffort }
        : builtExtras),
      ...(profile.lane === 'openai-compat' || profile.lane === 'openrouter' ? { prompt_cache_key: cacheDomainKey } : {}),
    }
    return extra
  }
  const request: CompatChatRequest = {
    model: wireModel,
    messages: toolsInPrompt ? renderToolDialectHistory(mappedMessages) : mappedMessages,
    ...(apiTools.length > 0 && !toolsInPrompt
      ? {
          tools: wireTools,
          ...(profile.omitsToolChoice ? {} : { tool_choice: 'auto' as const }),
        }
      : {}),
    extra: makeRequestExtra(),
  }
  const effortFact =
    profile.effortOnWire?.(request.extra ?? {}) ??
    compatEffortWireFact(request.extra ?? {}, {
      thinkingGated: effortView.kind === 'provider' && effortView.thinkingGated,
      thinkingEnabled,
      supported: effortTruth.supportsEffort,
    })
  const effortOnWire: EffortStampV1 = effortStampOf(effortTruth.requested, effortFact)
  const withEffort = (message: AssistantMessage): AssistantMessage => ({ ...message, effort: effortOnWire })

  if (profile.requestFitRefusal) {
    const requestBytes = JSON.stringify(request).length
    const fitRefusal = profile.requestFitRefusal({
      requestBytes,
      estTokens: Math.ceil(requestBytes / 4),
      toolCount: apiTools.length,
      wireModel,
    })
    if (fitRefusal !== undefined) {
      yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${fitRefusal}`)
      return
    }
  }

  recordPromptState({
    system: [{ text: systemText }],
    toolSchemas: apiTools as unknown as NeutralToolSchema[],
    querySource: options.querySource,
    model: modelId,
    agentId: options.agentId,
    ...(effortValue ? { effortValue } : {}),
    lane: profile.lane satisfies CacheLane,
    callReference: options.callReference,
  })

  let recovery: 'retried' | 'no-new-credential' | undefined
  const turnStartedAtMs = Date.now()
  let attemptStartedAtMs = turnStartedAtMs
  let busy: { ladder: BusyRetryLadder; fault: CompatFault } | undefined
  let reconnect: ReconnectLadder | undefined
  let emptyEnds = 0
  for (let attempt = 1; attempt <= COMPAT_MAX_ATTEMPTS || busy !== undefined; attempt++) {
    if (attempt > 1) {
      if (profile.lane === 'openrouter' || profile.lane === 'huggingface' || profile.lane === 'gemini') {
        const { refreshProviderUsage } = await import('../providerUsage.js')
        await refreshProviderUsage(profile.lane, { force: true, reason: 'operator' })
      }
      const refreshed = await profile.resolveCredential()
      if (refreshed) credential = refreshed
      if (profile.dialect === 'llamacpp') {
        const slot = makeRequestExtra().id_slot
        if (typeof slot === 'number') request.extra = { ...request.extra, id_slot: slot, cache_prompt: true }
        else if (request.extra) { delete request.extra.id_slot; request.extra.cache_prompt = true }
      }
    }
    attemptStartedAtMs = Date.now()
    if (!toolsInPrompt) request.messages = replayKimiHistory(mappedMessages, preparedMessages, wireModel, credential.requestUrl ?? profile.requestUrl())
    const signInRequest = captureSignInRequest(profile.lane, credential.apiKey)
    const outcome = yield* streamOneCompatAttempt({
      profile,
      request,
      apiKey: credential.apiKey,
      requestUrl: credential.requestUrl ?? profile.requestUrl(),
      signal,
      tools: tools.filter(tool => !withheldTools.has(tool.name)),
      options,
      modelId,
      messages,
      preparedMessages,
      deferredUnadmitted: plan.isDeferredUnadmitted,
      callableTools,
      effort: effortOnWire,
      ...(deferral !== undefined ? { deferral } : {}),
      ...((profile.leadingNotes?.length || toolNotes.length) ? { leadingNotes: [...(profile.leadingNotes ?? []), ...toolNotes] } : {}),
      ...(busy !== undefined ? { busy } : {}),
    })
    if (outcome.kind === 'done') {
      observeSignInResponse(signInRequest, 200)
      liveProof.set(profile.lane, { at: Date.now(), model: modelId })
      if (outcome.served !== undefined) profile.noteServedModel?.(modelId, outcome.served, credential)
      recordLaneTurnSettled(profile.lane)
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    observeSignInResponse(signInRequest, outcome.fault.status, outcome.fault.message)
    const typed = compatFaultToTypedError(outcome.fault)
    if (
      typed === 'authentication_failed' &&
      outcome.retryEligible &&
      recovery === undefined &&
      profile.recoverCredential &&
      attempt < COMPAT_MAX_ATTEMPTS
    ) {
      const fresh = await profile.recoverCredential().catch(() => undefined)
      if (signal.aborted) return
      if (fresh?.apiKey !== undefined && fresh.apiKey !== credential.apiKey) {
        recovery = 'retried'
        credential = fresh
        continue
      }
      if (fresh !== null) recovery = 'no-new-credential'
    }
    const askedMs = outcome.fault.retryAfterMs
    const wireDetail = outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code
    const singleShot = options.querySource === 'overload_probe'
    const streamCut = outcome.retryEligible && !singleShot ? streamReconnectCause(outcome.fault) : null
    if (streamCut !== null) {
      const now = Date.now()
      const ladder = reconnect ?? openReconnectLadder(now, streamCut)
      reconnect = ladder
      const step = nextReconnect(ladder, streamCut, now)
      if (step.waitMs <= 0) {
        options.onWait?.(null)
        yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${streamReconnectSpentLine(profile.providerLabel, outcome.fault.silentMs)}`, typed, 'stream-reconnect-spent'))
        return
      }
      const wait = streamReconnectWait(step.reconnect, step.of, step.waitMs, outcome.fault.silentMs)
      const notice = createSystemAPIErrorMessage(Object.assign(new Error(requestWaitLine(wait)), { streamWait: wait }), step.waitMs, step.reconnect, step.of)
      options.onWait?.(wait)
      yield notice
      await sleep(step.waitMs, signal)
      if (signal.aborted) { options.onWait?.(null); return }
      attempt--
      continue
    }
    const outage = outcome.retryEligible && !singleShot ? outcome.fault.outage : undefined
    if (outage !== undefined) {
      const now = Date.now()
      const ladder = reconnect ?? openReconnectLadder(now, outage)
      reconnect = ladder
      const step = nextReconnect(ladder, outage, now)
      const notice = createSystemAPIErrorMessage(new NetworkOutageError(step, Object.assign(new Error(outcome.fault.message), { code: outage.code })), step.waitMs, step.reconnect, step.of)
      logForDebugging(`[compat:${profile.lane}] network outage (${wireDetail}) — ${notice.error.message}`)
      yield notice
      options.onWait?.({ kind: 'retry', attempt: step.reconnect, of: step.of, reason: retryReasonWords(undefined, notice.error.message), delayMs: step.waitMs, sinceMs: now })
      if (step.waitMs <= 0) {
        yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${new ReconnectBudgetSpentError(ladder, now, undefined).message}`, typed, outcome.fault.code))
        return
      }
      await sleep(step.waitMs, signal)
      if (signal.aborted) return
      attempt--
      continue
    }
    if (outcome.fault.status !== undefined) reconnect = undefined
    if (outcome.retryEligible && !singleShot && takesBusyLadder(outcome.fault, typed) && !providerWaitIsWindow(askedMs)) {
      const ladder = busy?.ladder ?? openBusyRetryLadder(Date.now())
      busy = { ladder, fault: outcome.fault }
      const step = nextBusyRetry(ladder, askedMs, Date.now())
      if (step !== null) {
        logForDebugging(`[compat:${profile.lane}] busy refusal (${wireDetail}) — retry ${step.attempt} of ${step.of} after ${retrySeconds(step.waitMs)}${step.quiet ? ' inside the quiet window' : ''}`)
        const notice = createSystemAPIErrorMessage(
          Object.assign(new Error(outcome.fault.message), {
            ...(outcome.fault.status !== undefined ? { status: outcome.fault.status } : {}),
            ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
          }),
          step.waitMs,
          step.attempt,
          step.of,
        )
        if (!step.quiet) {
          yield notice
          options.onWait?.(retryNoticeWait(notice))
        } else if (options.agentId !== undefined) options.onWait?.(heldBusyRetryWait(step, notice))
        await sleep(step.waitMs, signal)
        if (signal.aborted) return
        continue
      }
      logForDebugging(`[compat:${profile.lane}] busy refusal (${wireDetail}) — the retry ladder is spent after ${ladder.waitsMs.length} retries and ${retrySeconds(ladder.spentMs)} of waiting`)
    }
    const emptyEnd = busy === undefined && !singleShot && outcome.retryEligible && isEmptyStreamFault(outcome.fault)
    if (emptyEnd) {
      emptyEnds++
      if (emptyEnds < EMPTY_STREAM_TRIES) {
        const waitMs = emptyStreamRetryWaitMs()
        const notice = emptyStreamRetryNotice({ provider: profile.providerLabel, detail: outcome.fault.code, attempt: emptyEnds + 1, waitMs })
        logForDebugging(`[compat:${profile.lane}] ${notice.error.message} — retrying in ${retrySeconds(waitMs)} (attempt ${emptyEnds + 1} of ${EMPTY_STREAM_TRIES})`, { level: 'warn' })
        yield notice
        options.onWait?.(retryNoticeWait(notice))
        await sleep(waitMs, signal)
        if (signal.aborted) return
        attempt--
        continue
      }
      logForDebugging(`[compat:${profile.lane}] ${emptyStreamSpentWords(profile.providerLabel, Date.now() - turnStartedAtMs)} (${wireDetail})`, { level: 'error' })
    }
    const retryable =
      !emptyEnd && busy === undefined && !singleShot && !providerWaitIsWindow(askedMs) && outcome.retryEligible && outcome.fault.retryable && attempt < COMPAT_MAX_ATTEMPTS
    if (retryable) {
      const delayMs = Math.max(COMPAT_RETRY_BACKOFF_MS * attempt, askedMs ?? 0)
      const notice = createSystemAPIErrorMessage(
        Object.assign(new Error(outcome.fault.message), {
          ...(outcome.fault.status !== undefined ? { status: outcome.fault.status } : {}),
          ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
        }),
        delayMs,
        attempt,
        COMPAT_MAX_ATTEMPTS - 1,
      )
      yield notice
      options.onWait?.(retryNoticeWait(notice))
      await sleep(delayMs, signal)
      if (signal.aborted) return
      continue
    }
    const wall = classifyCredentialWall(outcome.fault.status, outcome.fault.message, recovery !== undefined ? 'sign-in' : undefined)
    if (wall !== undefined) {
      const wireSaid = outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code
      logForDebugging(`[compat:${profile.lane}] credential wall (${wall}) — the wire said: ${wireSaid}${recovery === 'retried' ? '; the stored token was refreshed and the call retried once first' : recovery === 'no-new-credential' ? '; a token refresh was attempted first and produced no new credential' : ''}`)
      const line = credentialWallLine(profile.lane, wall)
      if (wall === 'key-limit') recordLaneBillingRefusal(profile.lane, { detail: wireSaid, remedy: line })
      if (wall === 'sign-in') profile.onCredentialRefused?.(outcome.fault)
      yield withEffort(apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${line}`, wall === 'key-limit' ? 'billing_error' : 'authentication_failed'))
      return
    }
    if (typed === 'authentication_failed') profile.onCredentialRefused?.(outcome.fault)
    if (typed === 'billing_error') {
      recordLaneBillingRefusal(profile.lane, {
        detail: outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code,
        remedy: profile.billingRemedy ?? 'top up the account at the provider, then retry; /model picks another model meanwhile.',
      })
    }
    const refusedImage = imageRefusalWords(request, outcome.fault)
    if (refusedImage !== null) {
      noteImageRefusal(modelId, refusedImage)
      const serverRefusal = compatImageRefusalWords(modelId, refusedImage)
      yield withEffort(apiErrorMessage(
        serverRefusal !== null
          ? `${API_ERROR_MESSAGE_PREFIX}: ${serverRefusal} — the server refused the image: ${refusedImage}`
          : `${API_ERROR_MESSAGE_PREFIX}: the model on the ${profile.providerLabel} route refused the image: ${refusedImage} — the next request carries it as [image]; the Computer tool refuses on this model until /model picks one that receives images`,
        typed,
        outcome.fault.code,
        overflowOf(profile, outcome.fault, { request, model: modelId }),
        null,
        { blockTypes: ['image'], detail: refusedImage },
      ))
      return
    }
    const terminalText = compatTerminalFaultText(profile, outcome.fault, typed, recovery ? { recovery } : undefined) + (profile.policyFaultNote?.(outcome.fault, request.extra) ?? '')
    const stayedBusy =
      busy !== undefined && takesBusyLadder(outcome.fault, typed)
        ? `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} stayed busy through ${busy.ladder.waitsMs.length} ${busy.ladder.waitsMs.length === 1 ? 'retry' : 'retries'} over ${retrySeconds(Date.now() - busy.ladder.startedAtMs)} — ${terminalText.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
        : emptyEnd
          ? `${API_ERROR_MESSAGE_PREFIX}: ${emptyStreamSpentWords(profile.providerLabel, Date.now() - turnStartedAtMs)} — ${terminalText.slice(`${API_ERROR_MESSAGE_PREFIX}: `.length)}`
          : terminalText
    yield withEffort(stampProviderWait(
      markUnknownModel(apiErrorMessage(
        stayedBusy,
        typed,
        outcome.fault.code,
        overflowOf(profile, outcome.fault, { request, model: modelId }),
        busy !== undefined ? busyRefusalFact(profile.providerLabel, busy.ladder, outcome.fault) : null,
      ), outcome.fault.status),
      outcome.fault.retryAfterMs,
    ))
    return
  }
}

async function* streamOneCompatAttempt(ctx: {
  profile: CompatLaneProfile
  request: CompatChatRequest
  apiKey: string | undefined
  requestUrl: string
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  preparedMessages: Message[]
  deferredUnadmitted?: (name: string) => boolean
  callableTools?: readonly ApiShapedTool[]
  effort?: EffortStampV1
  deferral?: CompatDeferralFacts
  leadingNotes?: readonly string[]
  busy?: { ladder: BusyRetryLadder; fault: CompatFault }
}): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { profile, request, apiKey, requestUrl, signal, tools, options, modelId } = ctx

  const partial: ApiMessage = {
    id: `${profile.lane}_${randomUUID()}`,
    type: 'message' as const,
    role: 'assistant' as const,
    model: modelId,
    content: [] as ContentBlock[],
    stop_reason: null,
    stop_sequence: null as string | null,
    usage: { ...EMPTY_USAGE },
    container: null,
    context_management: null,
  }
  const streamEvent = (event: ApiStreamEvent): StreamEvent => ({
    type: 'stream_event',
    event,
  })
  const busyRecoveryStamp = (): AssistantMessage['busyRecovery'] => {
    if (ctx.busy === undefined || minted.length > 0) return undefined
    const { ladder, fault } = ctx.busy
    return {
      provider: profile.providerLabel,
      retries: ladder.waitsMs.length,
      elapsedMs: Date.now() - ladder.startedAtMs,
      ...(fault.status !== undefined ? { status: fault.status } : {}),
      code: fault.code,
      detail: busyRecoveryDetail({ provider: profile.providerLabel, status: fault.status, code: fault.code, message: fault.message, waitsMs: ladder.waitsMs }),
    }
  }
  const mintBlock = (block: ContentBlock): AssistantMessage => {
    const busyRecovery = busyRecoveryStamp()
    return {
      message: {
        ...partial,
        content: normalizeContentFromAPI([block], tools),
      } as AssistantMessage['message'],
      requestId: undefined,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      ...(busyRecovery !== undefined ? { busyRecovery } : {}),
      ...(ctx.effort !== undefined ? { effort: ctx.effort } : {}),
    }
  }

  let messageStarted = false
  let contentStarted = false
  let toolFragmentSeen = false
  let firstEventSeen = false
  const blocks = {
    index: -1,
    open: null as
      | { kind: 'thinking' | 'text'; value: string }
      | { kind: 'tool'; toolIndex: number }
      | null,
  }
  const toolPaints = new Map<number, { id: string; name: string; text: string; closed: boolean }>()
  const paintSlots: Array<{ toolIndex: number; id: string; at: number }> = []
  const pendingToolFragments = new Map<number, string>()
  const minted: AssistantMessage[] = []
  const preserveKimi = isKimiK3WireModel(request.model)
  let kimiReasoning: string | undefined
  let kimiContent = ''
  let released = 0
  let usageSeen: CompatUsage | undefined
  let served: string | undefined
  let finish:
    | {
        reason: CompatFinishReason
        rawReason: string
        toolCalls: CompatCompletedToolCall[]
      }
    | undefined
  let fault: CompatFault | undefined

  function* ensureMessageStart(): Generator<StreamEvent> {
    if (messageStarted) return
    messageStarted = true
    yield streamEvent({ type: 'message_start', message: { ...partial, content: [] } })
  }
  function* releaseMinted(): Generator<AssistantMessage> {
    const limit = Math.min(minted.length - 1, paintSlots[0]?.at ?? minted.length)
    while (released < limit) yield minted[released++]!
  }
  function* pushMinted(message: AssistantMessage): Generator<AssistantMessage> {
    minted.push(message)
    yield* releaseMinted()
  }
  function* closeOpenBlock(): Generator<StreamEvent | AssistantMessage> {
    if (!blocks.open) return
    if (blocks.open.kind === 'tool') {
      const paint = toolPaints.get(blocks.open.toolIndex)
      if (paint) paint.closed = true
      blocks.open = null
      yield streamEvent({ type: 'content_block_stop', index: blocks.index })
      return
    }
    const settled: ContentBlock =
      blocks.open.kind === 'thinking'
        ? { type: 'thinking', thinking: blocks.open.value, signature: '' }
        : { type: 'text', text: blocks.open.value, citations: null }
    blocks.open = null
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    yield* pushMinted(mintBlock(settled))
  }
  function* openNewBlock(kind: 'thinking' | 'text'): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index += 1
    blocks.open = { kind, value: '' }
    yield streamEvent({
      type: 'content_block_start',
      index: blocks.index,
      content_block:
        kind === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '', citations: null },
    })
  }
  function* emitSettledBlock(
    block: ContentBlock,
    deltas: ApiContentBlockDelta[],
    startBlock: ContentBlock,
    decorate?: (message: AssistantMessage) => void,
  ): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index += 1
    yield streamEvent({ type: 'content_block_start', index: blocks.index, content_block: startBlock })
    for (const delta of deltas) {
      yield streamEvent({ type: 'content_block_delta', index: blocks.index, delta })
    }
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(block)
    decorate?.(m)
    yield* pushMinted(m)
  }
  function refusalNoteMessage(refusal: RefusedToolCall): { note: string; decorate: (message: AssistantMessage) => void } {
    const note = toolCallRefusalNote(profile.lane, refusal)
    logForDebugging(`[compat:${profile.lane}] ${toolCallRefusalDiagnostic(refusal)}`, { level: 'warn' })
    return {
      note,
      decorate: message => {
        message.refusedToolCalls = [refusal]
      },
    }
  }
  let leadingNotesEmitted = false
  function* emitLeadingNotes(): Generator<StreamEvent | AssistantMessage> {
    if (leadingNotesEmitted) return
    leadingNotesEmitted = true
    for (const note of ctx.leadingNotes ?? []) {
      yield* emitSettledBlock(
        { type: 'text', text: note, citations: null },
        [{ type: 'text_delta', text: note }],
        { type: 'text', text: '', citations: null },
      )
    }
  }

  const extraHeaders = profile.extraHeaders?.()
  const idleTimeoutMs = streamIdleTimeoutMsForRoute(profile.lane, profile.dialect)
  const cold = coldPrefixOf(ctx.messages, modelId)
  const promptTokens = estimateRequestTokens(request)
  const prefillTokensPerSecond = await profile.prefillTokensPerSecond?.()
  if (signal.aborted) return { kind: 'cancelled' }
  const prefillMs = measuredPrefillMs(promptTokens, prefillTokensPerSecond)
  const pinnedSlot = typeof request.extra?.id_slot === 'number' ? request.extra.id_slot : undefined
  const streamOptions: CompatStreamOptions = {
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(profile.onResponseHeaders ? { onResponseHeaders: profile.onResponseHeaders } : {}),
    ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    url: requestUrl,
    request,
    signal,
    idleTimeoutMs,
    silentAfterHeadersMs: silentAfterHeadersWindowMs({ route: profile.lane, dialect: profile.dialect, cold, promptTokens, idleMs: idleTimeoutMs, prefillTokensPerSecond }),
    ...(profile.liveness !== undefined
      ? {
          liveness: {
            fenceMs: silentAfterHeadersWindowMs({ route: profile.lane, cold, promptTokens, idleMs: idleTimeoutMs }),
            read: () => profile.liveness!(pinnedSlot),
          },
        }
      : {}),
    ...(options.onStreamActivity ? { onStreamActivity: options.onStreamActivity } : {}),
    firstByte: {
      cold,
      promptTokens,
      ...(prefillMs !== undefined ? { prefillMs } : {}),
      model: getPublicModelDisplayName(modelId) ?? modelId,
      ...(options.onWait ? { onWait: options.onWait } : {}),
    },
    ...(ctx.deferral !== undefined ? { deferral: ctx.deferral } : {}),
  }
  if (profile.lane === 'local') {
    const law = localStreamLawFor({ wireModel: request.model, cold: streamOptions.firstByte!.cold, promptTokens: streamOptions.firstByte!.promptTokens })
    if (law !== undefined) streamOptions.local = law
  }
  const transport = profile.streamTransport?.(streamOptions, ctx.preparedMessages)
  const events = transport?.events ?? streamCompatChat(streamOptions)
  for await (const event of events) {
    if (!firstEventSeen) {
      firstEventSeen = true
    }
    switch (event.type) {
      case 'served-model':
        served = event.model
        break
      case 'reasoning-delta': {
        if (preserveKimi) kimiReasoning = (kimiReasoning ?? '') + event.text
        contentStarted = true
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        if (blocks.open?.kind !== 'thinking') yield* openNewBlock('thinking')
        if (blocks.open?.kind === 'thinking') blocks.open.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'thinking_delta', thinking: event.text },
        })
        break
      }
      case 'reasoning-withheld': {
        contentStarted = true
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        const withheld: ContentBlock = { type: 'thinking', thinking: '', signature: event.signature }
        yield* emitSettledBlock(withheld, [], withheld)
        break
      }
      case 'text-delta': {
        if (preserveKimi) kimiContent += event.text
        contentStarted = true
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        if (blocks.open?.kind !== 'text') yield* openNewBlock('text')
        if (blocks.open?.kind === 'text') blocks.open.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'text_delta', text: event.text },
        })
        break
      }
      case 'tool-call-fragment': {
        toolFragmentSeen = true
        if (profile.lane === 'gemini') break
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        const paint = toolPaints.get(event.index)
        const id = event.id || paint?.id
        const name = event.name || paint?.name
        if (!id || !name) {
          if (event.argumentsFragment !== '') {
            pendingToolFragments.set(event.index, (pendingToolFragments.get(event.index) ?? '') + event.argumentsFragment)
          }
          break
        }
        if (paint !== undefined && (paint.closed || paint.id !== id)) {
          if (!paint.closed) yield* closeOpenBlock()
          break
        }
        if (paint === undefined) {
          yield* closeOpenBlock()
          blocks.index += 1
          toolPaints.set(event.index, { id, name, text: '', closed: false })
          paintSlots.push({ toolIndex: event.index, id, at: minted.length })
          blocks.open = { kind: 'tool', toolIndex: event.index }
          yield streamEvent({
            type: 'content_block_start',
            index: blocks.index,
            content_block: { type: 'tool_use', id, name, input: {} },
          })
        }
        const record = toolPaints.get(event.index)!
        const piece = (pendingToolFragments.get(event.index) ?? '') + event.argumentsFragment
        pendingToolFragments.delete(event.index)
        if (piece !== '') {
          record.text += piece
          yield streamEvent({
            type: 'content_block_delta',
            index: blocks.index,
            delta: { type: 'input_json_delta', partial_json: piece },
          })
        }
        break
      }
      case 'usage':
        usageSeen = profile.usageForSettlement?.(event.usage) ?? event.usage
        break
      case 'finish':
        finish = {
          reason: event.reason,
          rawReason: event.rawReason,
          toolCalls: event.toolCalls,
        }
        break
      case 'stream-fault':
        fault = fault ?? event.fault
        break
    }
  }

  if (fault?.kind === 'cancelled' || signal.aborted) {
    if (blocks.open?.kind === 'text' && blocks.open.value.length > 0) yield* closeOpenBlock()
    paintSlots.length = 0
    while (released < minted.length) yield minted[released++]!
    return { kind: 'cancelled' }
  }
  const hasTool = toolFragmentSeen || (finish?.toolCalls.length ?? 0) > 0
  const nothingYielded = !contentStarted && minted.length === 0 && !hasTool
  const retryStream = fault !== undefined && !finish && !hasTool && streamReconnectCause(fault) !== null
  const retryTemporary = fault !== undefined && isTemporaryStreamFault(fault) && !hasTool
  if (fault && nothingYielded && (!finish || retryTemporary)) {
    return { kind: 'fault', fault, retryEligible: !isLocalLivenessCut(fault) }
  }
  const typedEnd =
    fault !== undefined && !finish && !retryTemporary && !retryStream
      ? typedStreamEndOf({
          fault,
          provider: profile.providerLabel,
          tailStands: blocks.open === null && minted.at(-1)?.message.content[0]?.type === 'text',
          silentMs: streamIdleTimeoutMsForRoute(profile.lane),
        })
      : null

  yield* ensureMessageStart()
  let completed = finish?.toolCalls ?? []
  if (profile.lane === 'local' && completed.length === 0 && blocks.open !== null && blocks.open.kind !== 'tool' && finish !== undefined) {
    const extracted = extractToolCallMarkup(blocks.open.value, ctx.callableTools ?? [])
    if (extracted !== undefined) {
      logForDebugging(`[compat:local] ${extracted.calls.length} tool call(s) read from ${extracted.shape} markup the server left in the ${blocks.open.kind}`)
      completed = extracted.calls.map((call, index) => ({ index, id: `markup_${randomUUID().slice(0, 8)}_${index}`, name: call.name, argumentsRaw: call.argumentsRaw, malformed: false }))
      if (extracted.text === '') {
        yield streamEvent({ type: 'content_block_stop', index: blocks.index })
        blocks.open = null
      } else {
        blocks.open.value = extracted.text
      }
    }
  }
  if (blocks.open?.kind === 'tool') {
    const open = blocks.open
    const paint = toolPaints.get(open.toolIndex)
    const call = paint === undefined ? undefined : completed.find(entry => entry.index === open.toolIndex && entry.id === paint.id)
    if (paint !== undefined && call !== undefined && call.argumentsRaw.length > paint.text.length && call.argumentsRaw.startsWith(paint.text)) {
      const tail = call.argumentsRaw.slice(paint.text.length)
      paint.text = call.argumentsRaw
      yield streamEvent({
        type: 'content_block_delta',
        index: blocks.index,
        delta: { type: 'input_json_delta', partial_json: tail },
      })
    }
  }
  yield* closeOpenBlock()
  if (completed.length > 0) yield* emitLeadingNotes()

  const accepted: Array<{ call: CompatCompletedToolCall; input: Record<string, unknown> }> = []
  const verdicts = gateToolCalls(
    tools,
    completed.map(call => ({
      id: call.id,
      name: call.name,
      argumentsRaw: call.argumentsRaw,
      malformed: call.malformed,
    })),
    { deferredUnadmitted: ctx.deferredUnadmitted },
  )
  completed.forEach((call, index) => {
    const verdict = verdicts[index]!
    if (verdict.ok) accepted.push({ call, input: verdict.input })
  })
  const paintedCalls = new Set<CompatCompletedToolCall>()
  let inserted = 0
  for (const slot of paintSlots) {
    const at = completed.findIndex(entry => entry.index === slot.toolIndex && entry.id === slot.id && !paintedCalls.has(entry))
    if (at < 0) continue
    const call = completed[at]!
    const verdict = verdicts[at]!
    paintedCalls.add(call)
    let message: AssistantMessage
    if (verdict.ok) {
      message = mintBlock({ type: 'tool_use', id: call.id, name: call.name, input: verdict.input })
    } else {
      const refusal = refusalNoteMessage(verdict.refusal)
      message = mintBlock({ type: 'text', text: refusal.note, citations: null })
      refusal.decorate(message)
    }
    minted.splice(slot.at + inserted, 0, message)
    inserted += 1
  }
  paintSlots.length = 0
  yield* releaseMinted()
  for (const { call, input } of accepted) {
    if (paintedCalls.has(call)) continue
    yield* emitSettledBlock(
      { type: 'tool_use', id: call.id, name: call.name, input },
      [{ type: 'input_json_delta', partial_json: call.argumentsRaw }],
      { type: 'tool_use', id: call.id, name: call.name, input: {} },
    )
  }
  for (const [index, call] of completed.entries()) {
    const verdict = verdicts[index]!
    if (verdict.ok || paintedCalls.has(call)) continue
    const refusal = refusalNoteMessage(verdict.refusal)
    yield* emitSettledBlock(
      { type: 'text', text: refusal.note, citations: null },
      [{ type: 'text_delta', text: refusal.note }],
      { type: 'text', text: '', citations: null },
      refusal.decorate,
    )
  }
  const terminationNote = retryTemporary ? undefined : ((): string | undefined => {
    switch (finish?.reason) {
      case 'content_filter':
        return `[${profile.lane}] the provider ended this response under its content filter — the turn is incomplete by provider policy, not finished.`
      case 'insufficient_system_resource':
        return `[${profile.lane}] the provider ended this response: insufficient system resources (a documented transient) — the turn was cut short by the provider, not finished; continue or retry as needed.`
      case 'network_error':
        return `[${profile.lane}] the provider ended this response with a network error — the turn was cut short by the provider, not finished.`
      case 'other':
        return `[${profile.lane}] the provider ended this response with an unmapped finish reason ('${finish?.rawReason ?? 'none stated'}') — the turn may be incomplete; continue or retry as needed.`
      default:
        return undefined
    }
  })()
  if (terminationNote !== undefined) {
    yield* emitSettledBlock(
      { type: 'text', text: terminationNote, citations: null },
      [{ type: 'text_delta', text: terminationNote }],
      { type: 'text', text: '', citations: null },
    )
  }
  if (minted.length === 0) {
    yield* emitSettledBlock(
      { type: 'text', text: '', citations: null },
      [],
      { type: 'text', text: '', citations: null },
    )
  }

  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'stop'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = mapCompatUsageToAnthropic(usageSeen)
  if (!usageSeen && fault !== undefined) {
    const estimated = estimateFaultedRequestUsage({ lane: profile.lane, model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    addToTotalSessionCost(
      usageSeen.statedCostUSD ?? calculateUSDCost(modelId, finalUsage as never),
      finalUsage as never,
      modelId,
      usageSeen.statedCostUSD !== undefined ? { basis: 'wire-stated' } : undefined,
    )
    void checkResponseForCacheBreak(
      options.querySource,
      finalUsage.cache_read_input_tokens,
      finalUsage.cache_creation_input_tokens ?? 0,
      ctx.messages,
      options.agentId,
      null,
    )
  }
  const lastMessage = minted.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    if (typedEnd !== null) lastMessage.streamEnd = typedEnd
    if (preserveKimi && !fault && finish && accepted.length === completed.length) {
      lastMessage.kimiProviderTurn = {
        model: request.model, endpoint: requestUrl,
        projection: kimiReplayProjection(minted.flatMap(message => message.message.content)),
        assistant: { role: 'assistant', content: kimiContent || (accepted.length ? null : ''), ...(kimiReasoning === undefined ? {} : { reasoning_content: kimiReasoning }), ...(accepted.length ? { tool_calls: accepted.map(({ call }) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsRaw } })) } : {}) },
      }
    }
    transport?.settle?.(minted)
    yield lastMessage
    void settleTranscriptMessage(lastMessage)
  }
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault && (retryTemporary || retryStream)) return { kind: 'fault', fault, retryEligible: true }
  if (fault && typedEnd === null) {
    const faultRow = apiErrorMessage(
      streamFaultAfterPartialText(profile.providerLabel, fault.code, fault.message),
      compatFaultToTypedError(fault),
      fault.code,
      overflowOf(profile, fault, { request, model: modelId }),
    )
    yield ctx.effort !== undefined ? { ...faultRow, effort: ctx.effort } : faultRow
  }
  return { kind: 'done', ...(served !== undefined ? { served } : {}) }
}
