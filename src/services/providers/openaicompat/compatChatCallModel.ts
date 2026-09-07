import { settleTranscriptMessage } from '../../../utils/sessionStorage/writer.js'
import { processOwnerForLane } from '../../run/resolveOwner.js'
import { randomUUID } from 'crypto'
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
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../../types/message.js'
import { API_ERROR_MESSAGE_PREFIX, streamFaultAfterPartialText } from '../../api/errors.js'
import { coldPrefixOf, estimateRequestTokens, streamIdleTimeoutMsForRoute, typedStreamEndOf } from '../streamIdleBudget.js'
import { providerWaitIsWindow, stampProviderWait } from '../../api/recoveryBudget.js'
import { patienceSeconds } from '../patience.js'
import { createSystemAPIErrorMessage } from '../../../utils/messages/systemMessages.js'
import { getPublicModelDisplayName } from '../../../utils/model/model.js'
import { classifyOverflowFault, type OverflowSignal } from '../../api/overflowSignal.js'
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
import { resolveWireRequestedEffort } from '../../../utils/effort.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { classifyCredentialWall, credentialWallLine } from '../credentialWall.js'
import { logForDebugging } from '../../../utils/debug.js'
import { canonicalWireModelId } from '../routeLaw.js'
import {
  renderGenericInstructions,
  resolveBehaviourContract,
} from '../../../prompt/behaviourContract.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { estimateFaultedRequestUsage } from '../faultUsageEstimate.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../../utils/thinking.js'
import {
  getActivePulseTrace,
  isPulseMainSource,
  pulseMark,
} from '../../../utils/pulse/turnTrace.js'
import {
  notePulseStreamActivity,
  setPulsePhase,
} from '../../../utils/pulse/turnPhase.js'
import { mapMessagesToZai, mapToolsToZai, type ApiShapedTool } from '../zai/zaiCodec.js'
import {
  streamCompatChat,
  type CompatChatRequest,
  type CompatCompletedToolCall,
  type CompatFault,
  type CompatFinishReason,
  type CompatStreamEvent,
  type CompatUsage,
} from './compatChatClient.js'
import type { RefusedToolCall } from '../../../types/message.js'
import { gateToolCalls, toolCallRefusalNote } from '../toolCallGate.js'
import { foldAnnouncementIntoFirstUserTurn, planToolPayload, renderAdmissionRecordsAsText } from '../toolEconomy.js'

const COMPAT_MAX_ATTEMPTS = 2
const COMPAT_RETRY_BACKOFF_MS = 400

export type CompatLaneId =
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

export function compatDispatchModelId(model: string): string {
  return normalizeModelStringForAPI(model.trim())
}

export interface CompatCredential {
  apiKey?: string
  requestUrl?: string
}

export interface CompatLaneProfile {
  lane: CompatLaneId
  providerLabel: string
  resolveCredential(): CompatCredential | undefined | Promise<CompatCredential | undefined>
  credentialHint: string
  authRemedy?: string
  billingRemedy?: string
  recoverCredential?(): Promise<CompatCredential | undefined | null>
  requestUrl(): string
  wireModelId(modelId: string): string
  requestFitRefusal?(estimate: { requestBytes: number; estTokens: number; toolCount: number; wireModel: string }): string | undefined
  onResponseHeaders?(headers: Headers, status?: number): void
  extraHeaders?(): Record<string, string> | undefined
  omitsToolChoice?: boolean
  toolCapabilityRefusal?(wireModel: string): string | undefined
  buildExtras(args: {
    wireModel: string
    effortValue: string | undefined
    thinkingEnabled: boolean
    maxOutputTokensOverride: number | undefined
  }): Record<string, unknown>
  keepsReasoningHistory?(wireModel: string): boolean
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
): AssistantMessage {
  return createAssistantAPIErrorMessage({
    content,
    error,
    ...(errorDetails !== undefined ? { errorDetails } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
  })
}

function overflowOf(
  lane: CompatLaneId,
  fault: Pick<CompatFault, 'code' | 'message'> & { status?: number },
): OverflowSignal | null {
  return classifyOverflowFault({ family: lane, status: fault.status, code: fault.code, message: fault.message })
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

function vendorWordClass(code: string): TypedError | undefined {
  const zai = /^zai-(\d+)$/.exec(code)
  if (zai) return zaiCodeClass(Number(zai[1]))
  if (!code.startsWith('api-')) return undefined
  const word = code.slice('api-'.length)
  const google = GOOGLE_STATUS_CLASS[word]
  if (google) return google
  if (/rate[-_]?limit|quota|exhausted/i.test(word)) return 'rate_limit'
  if (/insufficient[-_]?(credit|balance|fund)|billing|payment|balance/i.test(word)) return 'billing_error'
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
  profile: Pick<CompatLaneProfile, 'providerLabel' | 'credentialHint' | 'authRemedy' | 'billingRemedy'>,
  fault: Pick<CompatFault, 'code' | 'message'> & { retryAfterMs?: number },
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
          ? ` — the provider asks for a ${patienceSeconds(fault.retryAfterMs)} wait${providerWaitIsWindow(fault.retryAfterMs) ? ', past the retry budget: a dispatched agent pauses until then' : ''}`
          : ''
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} is rate-limiting this account (${detail})${asked} — retry in a moment, or /model picks another model meanwhile.`
    }
    default:
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} stream failed (${fault.code}) — ${fault.message}`
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

export function mapCompatUsageToAnthropic(usage: CompatUsage | undefined): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
  }
}

const FINISH_TO_STOP: Record<CompatFinishReason, 'end_turn' | 'tool_use' | 'max_tokens'> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'end_turn',
  insufficient_system_resource: 'end_turn',
  other: 'end_turn',
}

type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: CompatFault; retryEligible: boolean }

export async function* compatChatCallModel(
  profile: CompatLaneProfile,
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  const modelId = compatDispatchModelId(options.model)

  const wireVerdict = canonicalWireModelId(options.model)
  if (!wireVerdict.ok) {
    yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${wireVerdict.reason}`)
    return
  }
  let credential = await profile.resolveCredential()
  if (credential === undefined) {
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${profile.credentialHint} Model '${modelId}' cannot run.`,
    )
    return
  }

  const pulseMain = isPulseMainSource(options.querySource, options.agentId)
  const pulseGeneration = getActivePulseTrace()?.generation ?? 0

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
  const apiTools = await buildApiShapedTools(plan.roster, options, modelId)
  const wireMessages = foldAnnouncementIntoFirstUserTurn(renderAdmissionRecordsAsText(messages), plan)
  const effortValue = resolveWireRequestedEffort(modelId, options.effortValue, { agentId: options.agentId })
  const systemText = renderGenericInstructions(resolveBehaviourContract([...systemPrompt]))
  const wireModel = profile.wireModelId(modelId)
  const thinkingEnabled = thinkingConfig.type !== 'disabled'
  if (apiTools.length > 0 && profile.toolCapabilityRefusal) {
    const refusal = profile.toolCapabilityRefusal(wireModel)
    if (refusal !== undefined) {
      yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${refusal}`)
      return
    }
  }
  const request: CompatChatRequest = {
    model: wireModel,
    messages: mapMessagesToZai(systemText, toBridgeMessages(healWalkableForWire(wireMessages)), {
      keepReasoningHistory: profile.keepsReasoningHistory?.(wireModel) ?? false,
    }),
    ...(apiTools.length > 0
      ? {
          tools: mapToolsToZai(apiTools),
          ...(profile.omitsToolChoice ? {} : { tool_choice: 'auto' as const }),
        }
      : {}),
    extra: profile.buildExtras({
      wireModel,
      effortValue,
      thinkingEnabled,
      maxOutputTokensOverride: options.maxOutputTokensOverride,
    }),
  }

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
  for (let attempt = 1; attempt <= COMPAT_MAX_ATTEMPTS; attempt++) {
    attemptStartedAtMs = Date.now()
    if (pulseMain) {
      pulseMark('api_request_sent')
      setPulsePhase(pulseGeneration, 'waiting')
    }
    const outcome = yield* streamOneCompatAttempt({
      profile,
      request,
      apiKey: credential.apiKey,
      requestUrl: credential.requestUrl ?? profile.requestUrl(),
      signal,
      tools,
      options,
      modelId,
      messages,
      pulseMain,
      pulseGeneration,
      deferredUnadmitted: plan.isDeferredUnadmitted,
    })
    if (outcome.kind === 'done') {
      liveProof.set(profile.lane, { at: Date.now(), model: modelId })
      recordLaneTurnSettled(profile.lane)
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
      }
      return
    }
    if (outcome.kind === 'cancelled') return
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
    const retryable =
      !providerWaitIsWindow(askedMs) && outcome.retryEligible && outcome.fault.retryable && attempt < COMPAT_MAX_ATTEMPTS
    if (retryable) {
      const delayMs = Math.max(COMPAT_RETRY_BACKOFF_MS * attempt, askedMs ?? 0)
      yield createSystemAPIErrorMessage(
        Object.assign(new Error(outcome.fault.message), {
          ...(outcome.fault.status !== undefined ? { status: outcome.fault.status } : {}),
          ...(askedMs !== undefined ? { headers: { 'retry-after': String(Math.ceil(askedMs / 1000)) } } : {}),
        }),
        delayMs,
        attempt,
        COMPAT_MAX_ATTEMPTS - 1,
      )
      await new Promise(resolve => {
        const t = setTimeout(resolve, delayMs)
        ;(t as any).unref?.()
      })
      if (signal.aborted) return
      continue
    }
    const wall = classifyCredentialWall(outcome.fault.status, outcome.fault.message)
    if (wall !== undefined) {
      const wireSaid = outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code
      logForDebugging(`[compat:${profile.lane}] credential wall (${wall}) — the wire said: ${wireSaid}`)
      const line = credentialWallLine(profile.lane, wall)
      if (wall === 'key-limit') recordLaneBillingRefusal(profile.lane, { detail: wireSaid, remedy: line })
      yield apiErrorMessage(`${API_ERROR_MESSAGE_PREFIX}: ${line}`, wall === 'key-limit' ? 'billing_error' : 'authentication_failed')
      return
    }
    if (typed === 'billing_error') {
      recordLaneBillingRefusal(profile.lane, {
        detail: outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code,
        remedy: profile.billingRemedy ?? 'top up the account at the provider, then retry; /model picks another model meanwhile.',
      })
    }
    yield stampProviderWait(
      apiErrorMessage(
        compatTerminalFaultText(profile, outcome.fault, typed, recovery ? { recovery } : undefined),
        typed,
        outcome.fault.code,
        overflowOf(profile.lane, outcome.fault),
      ),
      outcome.fault.retryAfterMs,
    )
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
  pulseMain: boolean
  pulseGeneration: number
  deferredUnadmitted?: (name: string) => boolean
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
    open: null as { kind: 'thinking' | 'text'; value: string } | null,
  }
  const minted: AssistantMessage[] = []
  let usageSeen: CompatUsage | undefined
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
  function* closeOpenBlock(): Generator<StreamEvent | AssistantMessage> {
    if (!blocks.open) return
    const settled: ContentBlock =
      blocks.open.kind === 'thinking'
        ? { type: 'thinking', thinking: blocks.open.value, signature: '' }
        : { type: 'text', text: blocks.open.value, citations: null }
    blocks.open = null
    yield streamEvent({ type: 'content_block_stop', index: blocks.index })
    const m = mintBlock(settled)
    minted.push(m)
    yield m
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
    minted.push(m)
    yield m
  }

  const extraHeaders = profile.extraHeaders?.()
  const events: AsyncGenerator<CompatStreamEvent> = streamCompatChat({
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(profile.onResponseHeaders ? { onResponseHeaders: profile.onResponseHeaders } : {}),
    ...(extraHeaders && Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    url: requestUrl,
    request,
    signal,
    idleTimeoutMs: streamIdleTimeoutMsForRoute(profile.lane),
    firstByte: {
      cold: coldPrefixOf(ctx.messages, modelId),
      promptTokens: estimateRequestTokens(request),
      model: getPublicModelDisplayName(modelId) ?? modelId,
      ...(options.onWait ? { onWait: options.onWait } : {}),
    },
  })
  for await (const event of events) {
    if (!firstEventSeen) {
      firstEventSeen = true
      if (ctx.pulseMain) {
        pulseMark('response_headers_received')
        pulseMark('first_stream_chunk_received')
        notePulseStreamActivity(ctx.pulseGeneration, 'chunk')
      }
    }
    switch (event.type) {
      case 'reasoning-delta': {
        yield* ensureMessageStart()
        if (blocks.open?.kind !== 'thinking') yield* openNewBlock('thinking')
        blocks.open!.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'thinking_delta', thinking: event.text },
        })
        break
      }
      case 'text-delta': {
        yield* ensureMessageStart()
        if (blocks.open?.kind !== 'text') yield* openNewBlock('text')
        blocks.open!.value += event.text
        yield streamEvent({
          type: 'content_block_delta',
          index: blocks.index,
          delta: { type: 'text_delta', text: event.text },
        })
        break
      }
      case 'tool-call-fragment':
        break
      case 'usage':
        usageSeen = event.usage
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
    return { kind: 'cancelled' }
  }
  const nothingYielded = !messageStarted && minted.length === 0
  if (fault && nothingYielded && !finish) {
    return { kind: 'fault', fault, retryEligible: true }
  }
  const typedEnd =
    fault !== undefined && !finish
      ? typedStreamEndOf({
          fault,
          provider: profile.providerLabel,
          tailStands: blocks.open === null && minted.at(-1)?.message.content[0]?.type === 'text',
          silentMs: streamIdleTimeoutMsForRoute(profile.lane),
        })
      : null

  yield* ensureMessageStart()
  yield* closeOpenBlock()

  const completed = finish?.toolCalls ?? []
  const accepted: Array<{ call: CompatCompletedToolCall; input: Record<string, unknown> }> = []
  const refused: RefusedToolCall[] = []
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
    else refused.push(verdict.refusal)
  })
  for (const { call, input } of accepted) {
    yield* emitSettledBlock(
      { type: 'tool_use', id: call.id, name: call.name, input },
      [{ type: 'input_json_delta', partial_json: call.argumentsRaw }],
      { type: 'tool_use', id: call.id, name: call.name, input: {} },
    )
  }
  for (const refusal of refused) {
    const note = toolCallRefusalNote(profile.lane, refusal)
    yield* emitSettledBlock(
      { type: 'text', text: note, citations: null },
      [{ type: 'text_delta', text: note }],
      { type: 'text', text: '', citations: null },
      message => {
        message.refusedToolCalls = [refusal]
      },
    )
  }
  const terminationNote = ((): string | undefined => {
    switch (finish?.reason) {
      case 'content_filter':
        return `[${profile.lane}] the provider ended this response under its content filter — the turn is incomplete by provider policy, not finished.`
      case 'insufficient_system_resource':
        return `[${profile.lane}] the provider ended this response: insufficient system resources (a documented transient) — the turn was cut short by the provider, not finished; continue or retry as needed.`
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
    void settleTranscriptMessage(lastMessage)
  }
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault && typedEnd === null) {
    yield apiErrorMessage(
      streamFaultAfterPartialText(profile.providerLabel, fault.code, fault.message),
      compatFaultToTypedError(fault),
      fault.code,
      overflowOf(profile.lane, fault),
    )
  }
  return { kind: 'done' }
}
