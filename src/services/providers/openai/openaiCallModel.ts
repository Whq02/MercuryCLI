import { settleTranscriptMessage } from '../../../utils/sessionStorage/writer.js'
import { createHash } from 'node:crypto'
import { getCwd } from '../../../utils/cwd.js'
import { mintCacheDomainKey } from '../../../utils/cache/cacheDomain.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { randomUUID } from 'crypto'
import type {
  ApiContentBlockDelta,
  ApiMessage,
  ApiStreamEvent,
  ContentBlock,
  MessageParam,
  TextPhase,
} from '../../../types/wire.js'
import type { Tools } from '../../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { API_ERROR_MESSAGE_PREFIX, streamFaultAfterPartialText } from '../../api/errors.js'
import { classifyOverflowFault, type OverflowSignal } from '../../api/overflowSignal.js'
import { EMPTY_USAGE } from '../../api/emptyUsage.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
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
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { estimateFaultedRequestUsage } from '../faultUsageEstimate.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'
import { getSessionId } from '../../../bootstrap/state.js'
import {
  getActivePulseTrace,
  isPulseMainSource,
  pulseMark,
} from '../../../utils/pulse/turnTrace.js'
import {
  notePulseStreamActivity,
  setPulsePhase,
} from '../../../utils/pulse/turnPhase.js'
import { notePrintPhase } from '../../../utils/printPhases.js'
import type { ApiShapedTool } from '../zai/zaiCodec.js'
import {
  renderOpenaiInstructions,
  resolveBehaviourContract,
} from '../../../prompt/behaviourContract.js'
import {
  resolveOpenaiAccount,
  resolveOpenaiRequestAuth,
  type OpenaiRequestAuth,
} from './openaiAccounts.js'
import {
  evaluateGptCandidate,
  qualifiedGptCandidates,
  refreshOpenaiCatalogue,
  resolveGptReasoningProfile,
  type ApexGptRole,
  type GptCandidate,
  type GptReasoningProfile,
} from './openaiCatalogue.js'
import { recordLiveQualification } from './qualificationStore.js'
import { recordOpenaiUsageLimit } from './openaiLimitState.js'
import { resolveWireRequestedEffort } from '../../../utils/effort.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { streamOpenaiResponses } from './openaiClient.js'
import {
  buildOpenaiResponsesRequest,
  decodeOpenaiTurnRecord,
  type BridgeMessage,
} from './responsesBridge.js'
import type {
  OpenaiCompletedToolCall,
  OpenaiFault,
  OpenaiFinishReason,
  OpenaiInputItem,
  OpenaiResponsesRequest,
  OpenaiStreamEvent,
  OpenaiUsage,
} from './openaiWire.js'
import type { RefusedToolCall } from '../../../types/message.js'
import { gateToolCalls, toolCallRefusalNote } from '../toolCallGate.js'
import { foldAnnouncementIntoFirstUserTurn, planToolPayload, renderAdmissionRecordsAsText } from '../toolEconomy.js'


let openaiLiveProof: { at: number; model: string } | null = null
export function openaiLiveProofState(): { at: number; model: string } | null {
  return openaiLiveProof
}

const OPENAI_MAX_ATTEMPTS = 2
const OPENAI_RETRY_BACKOFF_MS = 400

export function openaiRetryDelayMs(attempt: number): number {
  return OPENAI_RETRY_BACKOFF_MS * attempt
}

export function openaiFaultToTypedError(
  fault: Pick<import('./openaiWire.js').OpenaiFault, 'kind' | 'code'> & { status?: number },
): NonNullable<AssistantMessage['error']> {
  if (fault.kind === 'usage-limit') return 'rate_limit'
  if (fault.status !== undefined) {
    if (fault.status === 401 || fault.status === 403) return 'authentication_failed'
    if (fault.status === 402) return 'billing_error'
    if (fault.status === 429) return 'rate_limit'
    if (fault.status === 408 || fault.status >= 500) return 'server_error'
    if (fault.status >= 400) {
      return /invalid_api_key|authentication/.test(fault.code) ? 'authentication_failed' : 'invalid_request'
    }
  }
  if (/http-401|http-403|openai-invalid_api_key|openai-authentication/.test(fault.code)) {
    return 'authentication_failed'
  }
  if (fault.kind === 'api-error' && /http-4|openai-invalid/.test(fault.code)) {
    return 'invalid_request'
  }
  if (
    fault.kind === 'timeout' ||
    fault.kind === 'transport-error' ||
    fault.kind === 'truncated-stream' ||
    fault.kind === 'response-failed' ||
    fault.kind === 'http-error' ||
    fault.kind === 'api-error'
  ) {
    return 'server_error'
  }
  return 'unknown'
}

export interface OpenaiCallModelParams {
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
): AssistantMessage {
  return createAssistantAPIErrorMessage({
    content,
    error,
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
  })
}

function overflowOf(fault: { status?: number; code: string; message: string }): OverflowSignal | null {
  return classifyOverflowFault({ family: 'openai', status: fault.status, code: fault.code, message: fault.message })
}

export function toBridgeMessages(
  messages: Message[],
  querySource: Options['querySource'],
  targetModelId: string,
): { rows: BridgeMessage[]; reconstructedGptTurns: number } {
  const out: BridgeMessage[] = []
  const target = targetModelId.trim().toLowerCase()
  const gptTurnIds = new Set<string>()
  const recordedTurnIds = new Set<string>()
  const settledTurnIds = new Set<string>()
  for (const m of messages) {
    if (m.type === 'user') {
      const param = userMessageToMessageParam(m, false, false, querySource)
      out.push({ role: 'user', content: param.content })
    } else if (m.type === 'assistant') {
      const param = assistantMessageToMessageParam(
        m,
        false,
        false,
        querySource,
      )
      const decoded = decodeOpenaiTurnRecord(m.apexProviderTurn)
      const servedModel = typeof m.message.model === 'string' ? m.message.model : ''
      const sameModel = servedModel.trim().toLowerCase() === target
      const record = decoded && sameModel ? decoded : undefined
      const turnKey = typeof m.message.id === 'string' ? m.message.id : m.uuid
      if (servedModel.toLowerCase().startsWith('gpt')) gptTurnIds.add(turnKey)
      if (decoded) recordedTurnIds.add(turnKey)
      if (m.message.stop_reason != null) settledTurnIds.add(turnKey)
      out.push({
        role: 'assistant',
        content: param.content,
        ...(typeof m.message.id === 'string' ? { turnId: m.message.id } : {}),
        ...(record ? { turnRecord: record } : {}),
      })
    }
  }
  let reconstructed = 0
  for (const id of gptTurnIds) {
    if (settledTurnIds.has(id) && !recordedTurnIds.has(id)) reconstructed += 1
  }
  return { rows: out, reconstructedGptTurns: reconstructed }
}

const reconstructionNoted = new Set<string>()

function activeApexRole(options: Options): ApexGptRole {
  if (options.querySource === 'concourse_coordinator') return 'coordinator'
  if (options.agentId || String(options.querySource ?? '').startsWith('agent')) {
    return 'specialist'
  }
  return 'primary'
}

async function buildApiShapedTools(
  tools: Tools,
  options: Options,
  model: string,
): Promise<ApiShapedTool[]> {
  const schemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model,
      }),
    ),
  )
  const out: ApiShapedTool[] = []
  for (const schema of schemas) {
    const record = schema as { name?: string; description?: string; input_schema?: unknown }
    if (typeof record.name === 'string' && record.input_schema !== undefined) {
      out.push({
        name: record.name,
        ...(record.description ? { description: record.description } : {}),
        input_schema: record.input_schema,
      })
    }
  }
  return out
}

export function mapOpenaiUsageToAnthropic(usage: OpenaiUsage | undefined, webSearchRequests = 0): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
    server_tool_use: { ...EMPTY_USAGE.server_tool_use, web_search_requests: webSearchRequests },
  }
}

export function buildProviderUsageReceipt(usage: OpenaiUsage): NonNullable<
  NonNullable<AssistantMessage['apexProviderTurn']>['providerUsage']
> {
  const total = usage.inputTokens ?? 0
  const cached = usage.cachedInputTokens ?? 0
  return {
    inputTokensTotal: total,
    cachedInputTokens: cached,
    outputTokens: usage.outputTokens ?? 0,
    ...(typeof usage.reasoningOutputTokens === 'number'
      ? { reasoningOutputTokens: usage.reasoningOutputTokens }
      : {}),
    ...(cached > total ? { anomaly: 'cached-exceeds-total' as const } : {}),
  }
}

export function replayableItems(
  orderedItems: readonly OpenaiInputItem[],
  refused: readonly (Pick<RefusedToolCall, 'id'> & { code?: RefusedToolCall['code'] })[],
): OpenaiInputItem[] {
  const refusedIds = new Set(refused.filter(r => r.code !== 'duplicate-id').map(r => r.id))
  const seenCallIds = new Set<string>()
  const kept = orderedItems.filter(item => {
    if (item.type !== 'function_call') return true
    if (refusedIds.has(item.call_id) || seenCallIds.has(item.call_id)) return false
    seenCallIds.add(item.call_id)
    return true
  })
  return kept.filter((item, index) => {
    if (item.type !== 'reasoning') return true
    const next = kept[index + 1]
    return next !== undefined && next.type !== 'reasoning'
  })
}

const FINISH_TO_STOP: Record<OpenaiFinishReason, 'end_turn' | 'tool_use' | 'max_tokens'> = {
  completed: 'end_turn',
  tool_calls: 'tool_use',
  max_output_tokens: 'max_tokens',
  content_filter: 'end_turn',
  'other-incomplete': 'end_turn',
}

type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: OpenaiFault; retryEligible: boolean }

type QualificationOutcome =
  | { kind: 'ok'; modelId: string; candidate: GptCandidate }
  | { kind: 'degraded'; modelId: string; note: string }
  | { kind: 'refused'; message: string }

async function qualifyRequestedModel(
  requestedId: string,
  auth: OpenaiRequestAuth,
): Promise<QualificationOutcome> {
  const sourceKind = auth.account.kind
  const snapshot = await refreshOpenaiCatalogue(sourceKind)
  if (requestedId === 'gpt') {
    const candidates = qualifiedGptCandidates('specialist', sourceKind)
    const head = candidates[0]
    if (head) return { kind: 'ok', modelId: head.identity.canonicalId, candidate: head }
    return {
      kind: 'refused',
      message: snapshot?.lastError
        ? `the GPT class alias cannot resolve — the live model catalogue is unavailable (${snapshot.lastError}). Name an exact id (e.g. gpt-5.6-sol) or retry when the catalogue reachability recovers.`
        : `the GPT class alias cannot resolve — the ${auth.account.label} catalogue offers no usable GPT model.`,
    }
  }
  const evaluated = evaluateGptCandidate(requestedId, sourceKind)
  if (evaluated.ok) {
    return { kind: 'ok', modelId: evaluated.candidate.identity.canonicalId, candidate: evaluated.candidate }
  }
  const why = evaluated.why
  if (why.reason === 'catalogue-unavailable') {
    return {
      kind: 'degraded',
      modelId: requestedId,
      note: `[openai] the live model catalogue is unavailable${why.detail ? ` (${why.detail})` : ''} — proceeding with '${requestedId}' on the provider's default reasoning effort (no live effort vocabulary to resolve against).`,
    }
  }
  const qualified = qualifiedGptCandidates('specialist', sourceKind)
    .map(c => c.identity.canonicalId)
    .join(', ')
  const catalogueHint = qualified ? ` The catalogue offers: ${qualified}.` : ''
  const reasonText =
    why.reason === 'not-in-live-catalogue'
      ? `is not offered by the ${auth.account.label} live catalogue`
      : why.reason === 'hidden-or-retired'
        ? `is hidden/retired in the live catalogue (${why.detail})`
        : why.reason === 'unparseable-id'
          ? `is not a parseable GPT model id`
          : `is not accepted by the live catalogue (${why.reason})`
  return {
    kind: 'refused',
    message: `model '${requestedId}' ${reasonText}.${catalogueHint}`,
  }
}

export async function* openaiCallModel(
  params: OpenaiCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, options } = params
  const requestedId = normalizeModelStringForAPI(options.model).trim().toLowerCase()

  const account = resolveOpenaiAccount()
  if (!account) {
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: no OpenAI account source is connected — /logins signs in to this account or attaches an API key. Model '${requestedId}' cannot run.`,
    )
    return
  }
  let auth = await resolveOpenaiRequestAuth({ sourceKind: account.kind })
  if (!auth) {
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: the ${account.label} source failed to produce request credentials (expired/revoked sign-in or missing key) — reconnect the OpenAI account. Model '${requestedId}' cannot run.`,
    )
    return
  }

  const qualification = await qualifyRequestedModel(requestedId, auth)
  if (qualification.kind === 'refused') {
    yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${qualification.message}`)
    return
  }
  const modelId = qualification.modelId
  const candidate = qualification.kind === 'ok' ? qualification.candidate : undefined

  const pulseMain = isPulseMainSource(options.querySource, options.agentId)
  const pulseGeneration = getActivePulseTrace()?.generation ?? 0

  const plan = await planToolPayload({
    model: modelId,
    tools,
    messages,
    getToolPermissionContext: options.getToolPermissionContext,
    agents: options.agents,
    hasPendingMcpServers: options.hasPendingMcpServers,
    source: 'query',
  })
  const apiTools = await buildApiShapedTools(plan.roster, options, modelId)
  const wireMessages = foldAnnouncementIntoFirstUserTurn(renderAdmissionRecordsAsText(messages), plan)
  const requestedEffort = resolveWireRequestedEffort(modelId, options.effortValue)
  const profile: GptReasoningProfile = candidate
    ? resolveGptReasoningProfile(requestedEffort, candidate.live)
    : { source: 'model-default' }
  const settlementNotes: string[] = []
  if (profile.source === 'unsupported-fallback' && profile.adjustedFrom) {
    settlementNotes.push(
      `[openai] requested reasoning effort '${profile.adjustedFrom}' is not in ${modelId}'s live effort catalogue — using '${profile.wireEffort ?? 'the model default'}'.`,
    )
  }
  if (qualification.kind === 'degraded') {
    settlementNotes.push(qualification.note)
  }

  const bridge = toBridgeMessages(healWalkableForWire(wireMessages), options.querySource, modelId)
  const threadKey = `${getSessionId()}:${options.agentId ?? 'main'}`
  if (bridge.reconstructedGptTurns > 0 && !reconstructionNoted.has(threadKey)) {
    reconstructionNoted.add(threadKey)
    settlementNotes.push(
      `[openai] reconstructed continuation: ${bridge.reconstructedGptTurns} earlier GPT turn(s) predate reasoning capture — their content replays from the Mercury transcript (benign; new turns record full replay items).`,
    )
  }

  const contract = resolveBehaviourContract([...systemPrompt])
  const renderedInstructions = renderOpenaiInstructions(contract)
  const promptCacheKey = mintCacheDomainKey({
    providerScope: `openai:${auth.account.kind}`,
    servedModel: modelId,
    projectPath: getCwd(),
    behaviorContractDigest: createHash('sha256').update(renderedInstructions).digest('hex').slice(0, 16),
    toolSchemaDigest: createHash('sha256').update(JSON.stringify(apiTools)).digest('hex').slice(0, 16),
    ...(options.agentId ? { profileId: `agent:${options.agentId}` } : {}),
  })
  const request = buildOpenaiResponsesRequest({
    model: modelId,
    instructions: renderedInstructions,
    messages: bridge.rows,
    tools: apiTools,
    ...(profile.wireEffort ? { reasoningEffort: profile.wireEffort } : {}),
    promptCacheKey,
    imagesSupported: candidate?.live.inputModalities
      ? candidate.live.inputModalities.includes('image')
      : true,
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    ...(options.nativeWebSearch ? { nativeWebSearch: options.nativeWebSearch } : {}),
  })

  recordPromptState({
    system: [{ text: request.instructions ?? '' }],
    toolSchemas: apiTools as unknown as NeutralToolSchema[],
    querySource: options.querySource,
    model: modelId,
    agentId: options.agentId,
    effortValue: profile.wireEffort,
    lane: 'openai',
    callReference: options.callReference,
  })

  const turnStartedAtMs = Date.now()
  let attemptStartedAtMs = turnStartedAtMs
  let recovery: 'retried' | 'no-new-credential' | undefined
  for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt++) {
    attemptStartedAtMs = Date.now()
    notePrintPhase('dispatch')
    if (pulseMain) {
      pulseMark('api_request_sent')
      setPulsePhase(pulseGeneration, 'waiting')
    }
    const outcome = yield* streamOneOpenaiAttempt({
      request,
      auth,
      signal,
      tools,
      options,
      modelId,
      messages,
      settlementNotes,
      pulseMain,
      pulseGeneration,
      contractDigest: contract.digest,
      deferredUnadmitted: plan.isDeferredUnadmitted,
    })
    if (outcome.kind === 'done') {
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
      }
      openaiLiveProof = { at: Date.now(), model: modelId }
      recordLaneTurnSettled('openai')
      recordLiveQualification({
        modelId,
        role: activeApexRole(options),
        sourceKind: auth.account.kind,
        behaviourContractDigest: contract.digest,
        ...(profile.wireEffort ? { liveEffort: profile.wireEffort } : {}),
      })
      return
    }
    if (outcome.kind === 'cancelled') return
    const typed = openaiFaultToTypedError(outcome.fault)
    if (
      typed === 'authentication_failed' &&
      outcome.retryEligible &&
      recovery === undefined &&
      auth.account.kind === 'chatgpt-subscription' &&
      attempt < OPENAI_MAX_ATTEMPTS
    ) {
      const fresh = await resolveOpenaiRequestAuth({
        sourceKind: 'chatgpt-subscription',
        forceRefresh: true,
      }).catch(() => undefined)
      if (signal.aborted) return
      if (fresh && fresh.headers.authorization !== auth.headers.authorization) {
        recovery = 'retried'
        auth = fresh
        continue
      }
      recovery = 'no-new-credential'
    }
    const retryable =
      outcome.retryEligible && outcome.fault.retryable && attempt < OPENAI_MAX_ATTEMPTS
    if (retryable) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, openaiRetryDelayMs(attempt))
        ;(t as any).unref?.()
      })
      if (signal.aborted) return
      continue
    }
    if (outcome.fault.kind === 'usage-limit') {
      recordOpenaiUsageLimit(outcome.fault.resetsAtMs, auth.account.kind)
      const slotAppendix = ((): string => {
        try {
          const { slotWallAppendix } =
            require('../slotSwitch.js') as typeof import('../slotSwitch.js')
          return slotWallAppendix('openai')
        } catch {
          return ''
        }
      })()
      const laneRemedy = ((): string => {
        try {
          const { crossFamilyLaneRemedy } =
            require('../../rateLimitMessages.js') as typeof import('../../rateLimitMessages.js')
          const line = crossFamilyLaneRemedy('openai')
          return line === null ? '' : ` ${line}`
        } catch {
          return ''
        }
      })()
      yield apiErrorMessage(
        `${API_ERROR_MESSAGE_PREFIX}: the ${auth.account.label} usage window is reached (${outcome.fault.code}) — ${outcome.fault.message}. GPT work on this source pauses until it resets; Mercury never reroutes across providers silently, and never changes the account source without your word.${slotAppendix || ' Options: retry later · pick another model via /model · switch the OpenAI source explicitly (/router source).'}${laneRemedy}`,
        openaiFaultToTypedError(outcome.fault),
        `${outcome.fault.code}${outcome.fault.resetsAtMs !== undefined ? ` resets_at=${new Date(outcome.fault.resetsAtMs).toISOString()}` : ''}`,
      )
      return
    }
    const detail = outcome.fault.message
      ? `${outcome.fault.code}: ${outcome.fault.message}`
      : outcome.fault.code
    const text =
      typed === 'authentication_failed'
        ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI rejected the ${auth.account.label} credential (${detail}) — ${
            auth.account.kind === 'chatgpt-subscription'
              ? '/logins signs in to the ChatGPT account again'
              : 'set a valid OPENAI_API_KEY, or /logins attaches a fresh API key'
          }.${
            recovery === 'retried'
              ? ' The stored token was refreshed and the call retried once before this refusal.'
              : recovery === 'no-new-credential'
                ? ' A token refresh was attempted first and produced no new credential.'
                : ''
          }`
        : typed === 'billing_error'
          ? `${API_ERROR_MESSAGE_PREFIX}: OpenAI reports the ${auth.account.label} account out of credit (${detail}) — add credit to the OpenAI account, then retry; /model picks another model meanwhile.`
          : `${API_ERROR_MESSAGE_PREFIX}: OpenAI stream failed (${outcome.fault.code}) — ${outcome.fault.message}`
    if (typed === 'billing_error') {
      recordLaneBillingRefusal('openai', {
        detail,
        remedy: 'add credit to the OpenAI account, then retry; /model picks another model meanwhile.',
      })
    }
    yield apiErrorMessage(text, typed, outcome.fault.code, overflowOf(outcome.fault))
    return
  }
}

export async function* streamOneOpenaiAttempt(ctx: {
  _eventsForTesting?: AsyncIterable<OpenaiStreamEvent>
  request: OpenaiResponsesRequest
  auth: OpenaiRequestAuth
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  settlementNotes: readonly string[]
  pulseMain: boolean
  pulseGeneration: number
  contractDigest: string
  deferredUnadmitted?: (name: string) => boolean
}): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { request, auth, signal, tools, options, modelId } = ctx

  const partial: ApiMessage = {
    id: `openai_${randomUUID()}`,
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
  const mintBlock = (block: ContentBlock): AssistantMessage => ({
    message: {
      ...partial,
      content: normalizeContentFromAPI([block], tools, options.agentId),
    } as AssistantMessage['message'],
    requestId: undefined,
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  })

  let messageStarted = false
  let firstEventSeen = false
  const blocks = {
    index: -1,
    open: null as
      | {
          kind: 'thinking' | 'text'
          value: string
          phase?: TextPhase
        }
      | {
          kind: 'tool'
          itemId: string
          callId: string
          name: string
          bytes: number
        }
      | null,
  }
  const livePaintComplete = new Set<string>()
  let pendingTextPhase: TextPhase | undefined
  const minted: AssistantMessage[] = []
  let usageSeen: OpenaiUsage | undefined
  let responseId: string | undefined
  let finish:
    | {
        reason: OpenaiFinishReason
        toolCalls: Extract<OpenaiStreamEvent, { type: 'finish' }>['toolCalls']
        orderedItems: OpenaiInputItem[]
        refusalText: string
        unknownItemTypes: string[]
        webSearchCalls: Array<{ id: string; query?: string }>
        citations: Array<{ url: string; title: string }>
        incompleteDetail?: string
      }
    | undefined
  let fault: OpenaiFault | undefined

  function* ensureMessageStart(): Generator<StreamEvent> {
    if (messageStarted) return
    messageStarted = true
    yield streamEvent({ type: 'message_start', message: { ...partial, content: [] } })
  }
  function* closeOpenBlock(): Generator<StreamEvent | AssistantMessage> {
    if (!blocks.open) return
    if (blocks.open.kind === 'tool') {
      blocks.open = null
      yield streamEvent({ type: 'content_block_stop', index: blocks.index })
      return
    }
    const settled: ContentBlock =
      blocks.open.kind === 'thinking'
        ? { type: 'thinking', thinking: blocks.open.value, signature: '' }
        : {
            type: 'text',
            text: blocks.open.value,
            citations: null,
            ...(blocks.open.phase ? { phase: blocks.open.phase } : {}),
          }
    blocks.open = null
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(settled)
    minted.push(m)
    yield m
  }
  function* openNewBlock(kind: 'thinking' | 'text'): Generator<StreamEvent | AssistantMessage> {
    yield* closeOpenBlock()
    blocks.index += 1
    const phase = kind === 'text' ? pendingTextPhase : undefined
    blocks.open = { kind, value: '', ...(phase ? { phase } : {}) }
    yield streamEvent({
      type: 'content_block_start',
      index: blocks.index,
      content_block:
        kind === 'thinking'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '', citations: null, ...(phase ? { phase } : {}) },
    })
  }
  function* streamDelta(kind: 'thinking' | 'text', text: string): Generator<StreamEvent | AssistantMessage> {
    yield* ensureMessageStart()
    yield* emitLeadingNotes()
    if (blocks.open?.kind !== kind) yield* openNewBlock(kind)
    const open = blocks.open!
    if (open.kind === kind) open.value += text
    yield streamEvent({
      type: 'content_block_delta',
      index: blocks.index,
      delta:
        kind === 'thinking'
          ? { type: 'thinking_delta', thinking: text }
          : { type: 'text_delta', text },
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
    minted.push(m)
    yield m
  }
  function* emitNoteBlock(
    note: string,
    decorate?: (message: AssistantMessage) => void,
  ): Generator<StreamEvent | AssistantMessage> {
    yield* emitSettledBlock(
      { type: 'text', text: note, citations: null },
      [{ type: 'text_delta', text: note }],
      { type: 'text', text: '', citations: null },
      decorate,
    )
  }
  let leadingNotesEmitted = false
  function* emitLeadingNotes(): Generator<StreamEvent | AssistantMessage> {
    if (leadingNotesEmitted) return
    leadingNotesEmitted = true
    for (const note of ctx.settlementNotes) yield* emitNoteBlock(note)
  }

  const events =
    ctx._eventsForTesting ??
    streamOpenaiResponses({
      baseUrl: auth.baseUrl,
      headers: auth.headers,
      request,
      signal,
    })
  for await (const event of events) {
    if (!firstEventSeen) {
      firstEventSeen = true
      notePrintPhase('first_byte')
      if (ctx.pulseMain) {
        pulseMark('response_headers_received')
        pulseMark('first_stream_chunk_received')
        notePulseStreamActivity(ctx.pulseGeneration, 'chunk')
      }
    }
    switch (event.type) {
      case 'response-id':
        responseId = event.id
        break
      case 'reasoning-delta':
        yield* streamDelta('thinking', event.text)
        break
      case 'text-delta':
        yield* streamDelta('text', event.text)
        break
      case 'refusal-delta':
        yield* streamDelta('text', event.text)
        break
      case 'text-item-start':
        if (blocks.open?.kind === 'text') yield* closeOpenBlock()
        pendingTextPhase = event.phase
        break
      case 'text-item-done':
        if (blocks.open?.kind === 'text') {
          if (event.phase && !blocks.open.phase) blocks.open.phase = event.phase
          yield* closeOpenBlock()
        }
        pendingTextPhase = undefined
        break
      case 'tool-args-start': {
        yield* ensureMessageStart()
        yield* emitLeadingNotes()
        yield* closeOpenBlock()
        blocks.index += 1
        blocks.open = {
          kind: 'tool',
          itemId: event.itemId,
          callId: event.callId,
          name: event.name,
          bytes: 0,
        }
        yield streamEvent({
          type: 'content_block_start',
          index: blocks.index,
          content_block: { type: 'tool_use', id: event.callId, name: event.name, input: {} },
        })
        break
      }
      case 'tool-args-delta': {
        if (blocks.open?.kind === 'tool' && blocks.open.itemId === event.itemId) {
          blocks.open.bytes += event.delta.length
          yield streamEvent({
            type: 'content_block_delta',
            index: blocks.index,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          })
        }
        break
      }
      case 'tool-args-done': {
        if (blocks.open?.kind === 'tool' && blocks.open.itemId === event.itemId) {
          if (blocks.open.bytes === 0 && event.argsRaw !== '') {
            yield streamEvent({
              type: 'content_block_delta',
              index: blocks.index,
              delta: { type: 'input_json_delta', partial_json: event.argsRaw },
            })
          }
          livePaintComplete.add(blocks.open.callId)
          yield* closeOpenBlock()
        }
        break
      }
      case 'usage':
        usageSeen = event.usage
        break
      case 'finish':
        finish = {
          reason: event.reason,
          toolCalls: event.toolCalls,
          orderedItems: event.orderedItems,
          refusalText: event.refusalText,
          unknownItemTypes: event.unknownItemTypes,
          webSearchCalls: event.webSearchCalls ?? [],
          citations: event.citations ?? [],
          ...(event.incompleteDetail !== undefined
            ? { incompleteDetail: event.incompleteDetail }
            : {}),
        }
        if (event.responseId && !responseId) responseId = event.responseId
        break
      case 'stream-fault':
        fault = fault ?? event.fault
        break
    }
  }

  if (fault?.kind === 'cancelled' || signal.aborted) {
    return { kind: 'cancelled' }
  }
  const nothingYielded = !messageStarted && minted.length === 0
  if (fault && nothingYielded && !finish) {
    return { kind: 'fault', fault, retryEligible: true }
  }

  yield* ensureMessageStart()
  yield* closeOpenBlock()
  yield* emitLeadingNotes()

  const completed = finish?.toolCalls ?? []
  const accepted: Array<{ call: OpenaiCompletedToolCall; input: Record<string, unknown> }> = []
  const refused: RefusedToolCall[] = []
  const verdicts = gateToolCalls(
    tools,
    completed.map(call => ({
      id: call.callId,
      name: call.name,
      argumentsRaw: call.argumentsRaw,
      malformed: call.malformed,
    })),
    { deferredUnadmitted: ctx.deferredUnadmitted },
  )
  completed.forEach((call, index) => {
    const verdict = verdicts[index]!
    if (verdict.ok) accepted.push({ call, input: verdict.input })
    else refused.push(verdict.refusal)
  })
  for (const { call, input } of accepted) {
    if (livePaintComplete.has(call.callId)) {
      const m = mintBlock({
        type: 'tool_use',
        id: call.callId,
        name: call.name,
        input,
      })
      minted.push(m)
      yield m
      continue
    }
    yield* emitSettledBlock(
      { type: 'tool_use', id: call.callId, name: call.name, input },
      [{ type: 'input_json_delta', partial_json: call.argumentsRaw }],
      { type: 'tool_use', id: call.callId, name: call.name, input: {} },
    )
  }
  for (const refusal of refused) {
    yield* emitNoteBlock(toolCallRefusalNote('openai', refusal), message => {
      message.refusedToolCalls = [refusal]
    })
  }
  if (finish && finish.webSearchCalls.length > 0) {
    for (const call of finish.webSearchCalls) {
      const block: ContentBlock = { type: 'server_tool_use', id: call.id, name: 'web_search', input: call.query !== undefined ? { query: call.query } : {} }
      yield* emitSettledBlock(block, [], block)
    }
    const lastCall = finish.webSearchCalls[finish.webSearchCalls.length - 1]!
    const resultBlock: ContentBlock = {
      type: 'web_search_tool_result',
      tool_use_id: lastCall.id,
      content: finish.citations.map(citation => ({ type: 'web_search_result', title: citation.title, url: citation.url })),
    }
    yield* emitSettledBlock(resultBlock, [], resultBlock)
  }
  if (finish?.reason === 'content_filter') {
    yield* emitNoteBlock(
      '[openai] the provider ended this response under its content filter — the turn is incomplete by provider policy.',
    )
  }
  if (finish?.reason === 'other-incomplete') {
    yield* emitNoteBlock(
      `[openai] the provider ended this response INCOMPLETE (${finish.incompleteDetail ?? 'no reason stated'}) — the turn was cut short by the provider, not finished; continue or retry as needed.`,
    )
  }
  if (finish && finish.unknownItemTypes.length > 0) {
    yield* emitNoteBlock(
      `[openai] the provider returned output item types Mercury does not decode yet (${finish.unknownItemTypes.join(', ')}) — recording the omission rather than dropping it silently.`,
    )
  }
  if (minted.length === 0) {
    yield* emitSettledBlock(
      { type: 'text', text: '', citations: null },
      [],
      { type: 'text', text: '', citations: null },
    )
  }

  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'completed'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = mapOpenaiUsageToAnthropic(usageSeen, finish?.webSearchCalls.length ?? 0)
  if (!usageSeen && fault !== undefined) {
    const estimated = estimateFaultedRequestUsage({ lane: 'openai', model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    addToTotalSessionCost(
      calculateUSDCost(modelId, finalUsage as never),
      finalUsage as never,
      modelId,
    )
  }
  if (usageSeen) {
    void checkResponseForCacheBreak(
      options.querySource,
      finalUsage.cache_read_input_tokens,
      finalUsage.cache_creation_input_tokens ?? 0,
      ctx.messages,
      options.agentId,
      responseId ?? null,
    )
  }
  const lastMessage = minted.at(-1)
  if (lastMessage) {
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    const replayItems = replayableItems(finish?.orderedItems ?? [], refused)
    if (replayItems.length > 0) {
      lastMessage.apexProviderTurn = {
        provider: 'openai',
        items: replayItems as unknown[],
        ...(responseId ? { responseId } : {}),
        contractDigest: ctx.contractDigest,
        ...(usageSeen ? { providerUsage: buildProviderUsageReceipt(usageSeen) } : {}),
      }
    }
    void settleTranscriptMessage(lastMessage)
  }
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault) {
    yield apiErrorMessage(
      streamFaultAfterPartialText('OpenAI', fault.code, fault.message),
      undefined,
      undefined,
      overflowOf(fault),
    )
  }
  return { kind: 'done' }
}
