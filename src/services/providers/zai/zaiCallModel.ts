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
import { getPublicModelDisplayName } from '../../../utils/model/model.js'
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
import { resolveWireRequestedEffort } from '../../../utils/effort.js'
import { recordLaneBillingRefusal, recordLaneTurnSettled } from '../laneBillingState.js'
import { normalizeModelStringForAPI } from '../../../utils/model/model.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import { estimateFaultedRequestUsage } from '../faultUsageEstimate.js'
import { resolveZaiDispatch } from '../../../utils/router/providerDiscovery.js'
import {
  renderGenericInstructions,
  resolveBehaviourContract,
} from '../../../prompt/behaviourContract.js'
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
import {
  buildZaiChatRequest,
  type ApiShapedTool,
} from './zaiCodec.js'
import {
  streamZaiChat,
  zaiChatCompletionsUrl,
  type ZaiCompletedToolCall,
  type ZaiFault,
  type ZaiFinishReason,
  type ZaiStreamEvent,
  type ZaiUsage,
} from './zaiClient.js'
import type { RefusedToolCall } from '../../../types/message.js'
import { gateToolCalls, toolCallRefusalNote } from '../toolCallGate.js'
import { foldAnnouncementIntoFirstUserTurn, planToolPayload, renderAdmissionRecordsAsText } from '../toolEconomy.js'

const ZAI_MAX_OUTPUT_TOKENS = 131_072

let zaiLiveProof: { at: number; model: string } | null = null
export function zaiLiveProofState(): { at: number; model: string } | null {
  return zaiLiveProof
}
const ZAI_MAX_ATTEMPTS = 2
const ZAI_RETRY_BACKOFF_MS = 400

export interface ZaiCallModelParams {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}

import { glmAcceptsEffort, glmEffortsFor, glmThinkingLocked } from './glmPins.js'
import { nearestSupportedWireEffort } from '../openai/gptPins.js'
import {
  compatFaultToTypedError,
  compatTerminalFaultText,
} from '../openaicompat/compatChatCallModel.js'

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

function overflowOf(fault: Pick<ZaiFault, 'code' | 'message'> & { status?: number }): OverflowSignal | null {
  return classifyOverflowFault({ family: 'zai', status: fault.status, code: fault.code, message: fault.message })
}

function toBridgeMessages(
  messages: Message[],
  querySource: Options['querySource'],
): MessageParam[] {
  const out: MessageParam[] = []
  for (const m of messages) {
    if (m.type === 'user') {
      out.push(userMessageToMessageParam(m, false, false, querySource))
    } else if (m.type === 'assistant') {
      out.push(assistantMessageToMessageParam(m, false, false, querySource))
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

export function mapZaiUsageToAnthropic(usage: ZaiUsage | undefined): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
  }
}

const FINISH_TO_STOP: Record<ZaiFinishReason, 'end_turn' | 'tool_use' | 'max_tokens'> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  sensitive: 'end_turn',
  model_context_window_exceeded: 'end_turn',
  network_error: 'end_turn',
  other: 'end_turn',
}

const ZAI_FAULT_PROFILE = {
  providerLabel: 'Z.AI',
  credentialHint: 'no Z.AI API key detected — /logins zai stores one (general or GLM Coding Plan); ZAI_API_KEY works too.',
  authRemedy:
    'set a valid ZAI_API_KEY, or store a new key via /logins zai (z.ai/manage-apikey issues them — a GLM Coding Plan key must be stored as one, it is refused on the general base).',
  billingRemedy: 'top up the Z.AI account (its balance is exhausted), then retry; /model picks another model meanwhile.',
}

type AttemptOutcome =
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'fault'; fault: ZaiFault; retryEligible: boolean }

export async function* zaiCallModel(
  params: ZaiCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  const modelId = normalizeModelStringForAPI(options.model)

  const dispatch = resolveZaiDispatch()
  if (!dispatch) {
    yield apiErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${ZAI_FAULT_PROFILE.credentialHint} Model '${modelId}' cannot run.`,
    )
    return
  }
  const apiKey = dispatch.key

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
  const vocabulary = glmEffortsFor(modelId)
  const wireEffort =
    effortValue && vocabulary
      ? glmAcceptsEffort(modelId, effortValue)
        ? effortValue
        : nearestSupportedWireEffort(effortValue, [...vocabulary])
      : undefined
  const systemText = renderGenericInstructions(resolveBehaviourContract([...systemPrompt]))
  const request = buildZaiChatRequest({
    model: modelId,
    system: systemText,
    messages: toBridgeMessages(healWalkableForWire(wireMessages), options.querySource),
    tools: apiTools,
    maxTokens: Math.min(
      options.maxOutputTokensOverride ?? ZAI_MAX_OUTPUT_TOKENS,
      ZAI_MAX_OUTPUT_TOKENS,
    ),
    ...(wireEffort ? { reasoningEffort: wireEffort } : {}),
    thinkingEnabled: glmThinkingLocked(modelId) ? true : thinkingConfig.type !== 'disabled',
  })

  recordPromptState({
    system: [{ text: systemText }],
    toolSchemas: apiTools as unknown as NeutralToolSchema[],
    querySource: options.querySource,
    model: modelId,
    agentId: options.agentId,
    ...(effortValue ? { effortValue } : {}),
    lane: 'zai',
    callReference: options.callReference,
  })

  const turnStartedAtMs = Date.now()
  let attemptStartedAtMs = turnStartedAtMs
  for (let attempt = 1; attempt <= ZAI_MAX_ATTEMPTS; attempt++) {
    attemptStartedAtMs = Date.now()
    if (pulseMain) {
      pulseMark('api_request_sent')
      setPulsePhase(pulseGeneration, 'waiting')
    }
    const outcome = yield* streamOneZaiAttempt({
      request,
      apiKey,
      requestUrl: zaiChatCompletionsUrl(process.env, dispatch.plan),
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
      zaiLiveProof = { at: Date.now(), model: modelId }
      recordLaneTurnSettled('zai')
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    const retryable =
      outcome.retryEligible && outcome.fault.retryable && attempt < ZAI_MAX_ATTEMPTS
    if (retryable) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, ZAI_RETRY_BACKOFF_MS * attempt)
        ;(t as any).unref?.()
      })
      if (signal.aborted) return
      continue
    }
    const typed = compatFaultToTypedError(outcome.fault)
    if (typed === 'billing_error') {
      recordLaneBillingRefusal('zai', {
        detail: outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code,
        remedy: ZAI_FAULT_PROFILE.billingRemedy,
      })
    }
    yield apiErrorMessage(
      compatTerminalFaultText(ZAI_FAULT_PROFILE, outcome.fault, typed),
      typed,
      outcome.fault.code,
      overflowOf(outcome.fault),
    )
    return
  }
}

async function* streamOneZaiAttempt(ctx: {
  request: ReturnType<typeof buildZaiChatRequest>
  apiKey: string
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
  const { request, apiKey, requestUrl, signal, tools, options, modelId } = ctx

  const partial: ApiMessage = {
    id: `zai_${randomUUID()}`,
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
  let usageSeen: ZaiUsage | undefined
  let finish:
    | { reason: ZaiFinishReason; rawReason: string; toolCalls: ZaiCompletedToolCall[] }
    | undefined
  let fault: ZaiFault | undefined

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

  const events: AsyncGenerator<ZaiStreamEvent> = streamZaiChat({
    apiKey,
    request,
    signal,
    baseUrl: requestUrl,
    idleTimeoutMs: streamIdleTimeoutMsForRoute('zai'),
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
          provider: 'Z.AI',
          tailStands: blocks.open === null && minted.at(-1)?.message.content[0]?.type === 'text',
          silentMs: streamIdleTimeoutMsForRoute('zai'),
        })
      : null

  yield* ensureMessageStart()
  yield* closeOpenBlock()

  const completed = finish?.toolCalls ?? []
  const accepted: Array<{ call: ZaiCompletedToolCall; input: Record<string, unknown> }> = []
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
    const note = toolCallRefusalNote('zai', refusal)
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
      case 'sensitive':
        return `[zai] the provider ended this response under its content policy ('sensitive') — the turn is incomplete by provider policy, not finished.`
      case 'model_context_window_exceeded':
        return `[zai] the provider ended this response: the request exceeded the model's context window — the turn was cut short; compact or trim the conversation, then retry.`
      case 'network_error':
        return `[zai] the provider ended this response: a provider-side network error (a documented transient) — the turn was cut short, not finished; continue or retry as needed.`
      case 'other':
        return `[zai] the provider ended this response with an unmapped finish reason ('${finish?.rawReason ?? 'none stated'}') — the turn may be incomplete; continue or retry as needed.`
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
  const finalUsage = mapZaiUsageToAnthropic(usageSeen)
  if (!usageSeen && fault !== undefined) {
    const estimated = estimateFaultedRequestUsage({ lane: 'zai', model: modelId, request, minted, faultCode: fault.code })
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
      streamFaultAfterPartialText('Z.AI', fault.code, fault.message),
      compatFaultToTypedError(fault),
      fault.code,
      overflowOf(fault),
    )
  }
  return { kind: 'done' }
}
