// ============================================================================
//  providers/zai/zaiCallModel — the Z.AI GLM in-process model runtime
// the provider-aware branch behind QueryDeps.callModel.
//
//  This generator speaks queryModelWithStreaming's EXACT yield contract
//  (turn-machine.ts consumes it at run.deps.callModel):
//
//    - `{type:'stream_event', event}` per Mercury stream part (the
//      types/wire.ts grammar: message_start · content_block_start/delta/stop
//      · message_delta · message_stop), so the existing fan-out//
//      transcript machinery is untouched — and NO provider-SDK intermediate
//      exists on this lane;
//    - ONE AssistantMessage per settled content block (streamCore's
//      content_block_stop law), content normalized via the SAME
//      normalizeContentFromAPI;
//    - final usage + stop_reason written back onto the LAST yielded message
//      by DIRECT MUTATION (the transcript write queue holds the reference —
//      object replacement would disconnect it);
//    - provider trouble NEVER throws: terminal faults yield an
//      API_ERROR_MESSAGE_PREFIX assistant message the recovery ladder
//      already understands; cancellation returns quietly (the caller's
//      abort machinery owns that path).
//
//  Laws:
//    - NO second loop: the existing agent runtime runs GLM turns on a new
//      transport; tool calls settle as real tool_use blocks and Mercury's
//      own tools execute them.
//    - Text/thinking deltas stream LIVE; tool_use blocks settle EXACTLY ONCE
//      at finish from the client's validated accumulation (a malformed call
//      degrades to a visible text note — never a half-executed tool).
//    - Own bounded retry (retryable fault BEFORE any content only; never the
//      Anthropic OAuth/keychain machinery). The key never enters logs/errors.
//    - Honest refusals: key-absent yields a typed API-error message —
//      never a silent fallthrough to the Anthropic transport.
//    - GLM thinking blocks carry no signatures (Z.AI has none); they never
//      round-trip out (the bridge drops thinking on the request side), so
//      the unsigned blocks cannot reach the Anthropic API.
//  Known S5 gaps: no GLM cost accounting
//  (usage tokens ride the message; USD pricing is not invented) and the
//  autocompact context-window table still reads its conservative unknown-
//  model default for glm ids (compacts early, never overruns).
// ============================================================================
import { settleTranscriptMessage } from '../../../utils/sessionStorage/writer.js'
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

/** Documented glm-5.2 output ceiling (max_tokens ∈ [1, 131072]). */
const ZAI_MAX_OUTPUT_TOKENS = 131_072

// Session live-proof latch: readiness paints zai 'ready' ONLY after a real
// turn settled this session (configured is never painted ready).
let zaiLiveProof: { at: number; model: string } | null = null
export function zaiLiveProofState(): { at: number; model: string } | null {
  return zaiLiveProof
}
/** Bounded own retry: one retry, only for a retryable fault BEFORE content. */
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

// The documented reasoning_effort vocabulary lives in glmPins.ts (pure, the
// gptPins convention) so the capability edge ranks display truth from the
// SAME table this wire sends from. Requested levels outside a
// model's vocabulary resolve to the deepest supported level at or below the
// request (the shared wire-effort ordering) — glm-5.3 speaks low|high|max
// while the Mercury ladder also has xhigh/medium; omission would silently
// take the provider default instead of the operator's intent.
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

/** The typed overflow verdict for a fault on this lane — the one
 *  classifier owner (services/api/overflowSignal.ts): the HTTP refusal
 *  sentence, or the documented mid-stream finish reason
 *  `model_context_window_exceeded`; null for every other fault. */
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
    // progress/attachment/system messages are parent-side furniture — they
    // never reach a provider wire (the Anthropic path drops them too).
  }
  return out
}

async function buildApiShapedTools(
  tools: Tools,
  options: Options,
  model: string,
): Promise<ApiShapedTool[]> {
  // The Anthropic lane's order-preserving parallel pattern (streamCore's
  // schema build): ONE Promise.all over the roster — results land in
  // roster order by construction, cold-cache prompt builds overlap instead
  // of queueing tool-by-tool, and the shared tool-schema cache absorbs the
  // concurrent misses (keys are unique per tool).
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

/** The canonical DISJOINT envelope from Z.AI's INCLUSIVE usage
 *  (prompt_tokens ⊇ prompt_tokens_details.cached_tokens — the OpenAI-style
 *  accounting): the compat runtime's mapCompatUsageToAnthropic law, held
 *  here too, so the cached prefix is never billed twice. */
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

/** The Z.AI lane's remedies, composed through the shared class-aware text
 *  (compatTerminalFaultText) so an invalid key or an exhausted balance
 *  names the exact fix instead of "stream failed". */
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

/**
 * The provider-aware callModel branch for Z.AI GLM. Same parameter object and
 * yield union as queryModelWithStreaming — turn-machine.ts:489 consumes both
 * interchangeably.
 */
export async function* zaiCallModel(
  params: ZaiCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  const modelId = normalizeModelStringForAPI(options.model)

  // Honest refusal ladder — never a silent fallthrough to another provider.
  // The key and the base it is valid on resolve as ONE record (a GLM Coding
  // Plan key rides the Coding Plan base; the general key and an env key
  // ride the general base).
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

  // The tool-payload plan (../toolEconomy.ts): the roster law every route
  // obeys — deferred schemas absent until admitted, the name-only
  // announcement folded into the first user turn, admission records
  // rendered as text (this wire cannot expand a tool_reference).
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
  // the request input rides the ONE resolution owner (env level
  // wins; 'auto'/'unset' defer to the provider default — the key is omitted;
  // else the turn-floored appState value). The raw options value skipped the
  // env layer entirely on this wire.
  const effortValue = resolveWireRequestedEffort(modelId, options.effortValue)
  const vocabulary = glmEffortsFor(modelId)
  const wireEffort =
    effortValue && vocabulary
      ? glmAcceptsEffort(modelId, effortValue)
        ? effortValue
        : nearestSupportedWireEffort(effortValue, [...vocabulary])
      : undefined
  // The one-contract law: resolve the composed behaviour contract and render
  // the GENERIC family — the default contract alone, no other family's
  // overlay (Claude-currency and GPT-delta material never ride this wire).
  const systemText = renderGenericInstructions(resolveBehaviourContract([...systemPrompt]))
  const request = buildZaiChatRequest({
    model: modelId,
    system: systemText,
    // The pairing heal + split-turn fold run FIRST, exactly like the openai
    // and compat-chat seams: this lane sent the raw shape — a stopped
    // mid-turn transcript's orphaned tool_use rode unrepaired, and a
    // grouped round's per-block rows rode split.
    messages: toBridgeMessages(healWalkableForWire(wireMessages), options.querySource),
    tools: apiTools,
    maxTokens: Math.min(
      options.maxOutputTokensOverride ?? ZAI_MAX_OUTPUT_TOKENS,
      ZAI_MAX_OUTPUT_TOKENS,
    ),
    ...(wireEffort ? { reasoningEffort: wireEffort } : {}),
    // glm-5.3 refuses thinking:'disabled' (documented) — the lock wins over
    // the session's thinking config; other GLM ids keep the session choice.
    thinkingEnabled: glmThinkingLocked(modelId) ? true : thinkingConfig.type !== 'disabled',
  })

  // Cache-break phase 1: the GLM lane's wire prompt state — the
  // joined system string + the API-shaped tool schemas.
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

  // The lane FEEDS the shared api-duration ledger (FN-018 rank 11): the
  // final attempt is the api time, the whole loop the wall.
  const turnStartedAtMs = Date.now()
  let attemptStartedAtMs = turnStartedAtMs
  for (let attempt = 1; attempt <= ZAI_MAX_ATTEMPTS; attempt++) {
    attemptStartedAtMs = Date.now()
    // the actual dispatch boundary (retries re-mark honestly — point
    // marks are latched first-stamp-wins). Headers aren't separately visible
    // through the client seam, so the headers mark rides the first event.
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
        /* accounting must never fail the settled turn */
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    const retryable =
      outcome.retryEligible && outcome.fault.retryable && attempt < ZAI_MAX_ATTEMPTS
    if (retryable) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, ZAI_RETRY_BACKOFF_MS * attempt)
        // biome-ignore lint/suspicious/noExplicitAny: unref exists under node
        ;(t as any).unref?.()
      })
      if (signal.aborted) return
      continue
    }
    const typed = compatFaultToTypedError(outcome.fault)
    if (typed === 'billing_error') {
      // The usability owner marks the lane not usable until a turn settles.
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

/** One streaming attempt, translated live into the Anthropic-shaped contract. */
async function* streamOneZaiAttempt(ctx: {
  request: ReturnType<typeof buildZaiChatRequest>
  apiKey: string
  /** The chat-completions URL for the key's plan (the Coding Plan base for
   *  a GLM Coding Plan key, the general base otherwise). */
  requestUrl: string
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  /** The input history — cache-break phase 2's TTL-timing heuristic. */
  messages: Message[]
  pulseMain: boolean
  pulseGeneration: number
  /** The payload plan's predicate: a deferred tool this session has not
   *  admitted — a schema refusal for it names the admission road. */
  deferredUnadmitted?: (name: string) => boolean
}): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { request, apiKey, requestUrl, signal, tools, options, modelId } = ctx

  // The partialMessage streamCore builds at message_start — usage zeros and
  // stop_reason null until the finish write-back.
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
  // The lane speaks the Mercury stream grammar NATIVELY — the literal below
  // type-checks against ApiStreamEvent, no cast, no provider intermediate.
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
  // Block state lives in one object: the generator helpers below mutate it
  // through closures, and property access (unlike a narrowed `let`) stays
  // honest across those calls for the type system.
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
  /** A block settled whole at finish (tool_use / degradation notes).
   *  `decorate` stamps message-level facts (a refusal record) BEFORE the
   *  message is yielded, so every holder of the reference sees them. */
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
        break // exactly-once settlement happens at finish (client accumulates)
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
    // A clean pre-content failure — eligible for the bounded retry.
    return { kind: 'fault', fault, retryEligible: true }
  }

  // ── Settlement ────────────────────────────────────────────────────────────
  yield* ensureMessageStart()
  yield* closeOpenBlock()

  // The transport-boundary gate (../toolCallGate.ts): a tool_use block mints
  // ONLY for a call in the catalog whose settled arguments satisfy the
  // tool's schema; every other call settles as a visible note carrying its
  // typed refusal, which the turn machine hands back to the model.
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
  // A provider-side termination rides finish_reason on this wire (the
  // documented SSE abnormal-termination rule) and FINISH_TO_STOP maps it to
  // end_turn — without a note the provider-cut turn reads as the model
  // CHOOSING to stop, and the run then terminates on the api-error tail with
  // the model never told in-turn. Settle the openai lane's other-incomplete
  // treatment here too: a VISIBLE note carrying the provider's
  // own reason. The post-settle apiErrorMessage stays the operator/SDK
  // fault surface.
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
    // Zero content settled (degenerate stream) — mint one empty text block so
    // the loop always receives an assistant settlement.
    yield* emitSettledBlock(
      { type: 'text', text: '', citations: null },
      [],
      { type: 'text', text: '', citations: null },
    )
  }

  // A finish of 'tool_calls' whose every call was refused settles as
  // end_turn: stop_reason 'tool_use' is only ever true beside a minted block.
  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'stop'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = mapZaiUsageToAnthropic(usageSeen)
  if (!usageSeen && fault !== undefined) {
    // FN-018 rank 4: a stream that faulted after content carries no usage
    // frame, yet the provider billed the request — it joins the ledger at
    // the character estimate, never at zero.
    const estimated = estimateFaultedRequestUsage({ lane: 'zai', model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    // Usage truth: GLM turns join
    // the same session usage/cost ledger the Anthropic wire feeds.
    addToTotalSessionCost(
      calculateUSDCost(modelId, finalUsage as never),
      finalUsage as never,
      modelId,
    )
  }
  // Cache-break phase 2: the GLM lane maps cached prompt tokens
  // into the same usage spelling — fire-and-forget, never blocks the lane.
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
    // Direct mutation keeps in-memory holders current; the durable record
    // is settled explicitly below.
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    void settleTranscriptMessage(lastMessage)
  }
  yield streamEvent({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: finalUsage,
  })
  yield streamEvent({ type: 'message_stop' })

  if (fault) {
    // Content settled but the stream faulted (the documented finish_reason
    // failure channel, truncation, …) — surface it after settlement through
    // the SHARED continuable-class composer (the sibling of the OpenAI tail;
    // the turn machine's bounded recovery keys on the marker).
    yield apiErrorMessage(
      streamFaultAfterPartialText('Z.AI', fault.code, fault.message),
      compatFaultToTypedError(fault),
      fault.code,
      overflowOf(fault),
    )
  }
  return { kind: 'done' }
}
