// ============================================================================
//  providers/openaicompat/compatChatCallModel — the SHARED in-process model
//  runtime for the OpenAI-compatible chat-completions lanes:
// Moonshot/Kimi · DeepSeek · the operator-named compat slot.
//
//  One runtime, three thin lane profiles. This generator speaks
//  queryModelWithStreaming's EXACT yield contract, byte-for-byte the shape
//  zaiCallModel proves (turn-machine.ts consumes them interchangeably):
//    - Mercury stream parts per delta (message_start · content_block_* ·
//      message_delta · message_stop), NO provider-SDK intermediate;
//    - ONE AssistantMessage per settled content block; final usage +
//      stop_reason written back by DIRECT MUTATION; explicit transcript
//      settlement;
//    - provider trouble NEVER throws — terminal faults yield an
//      API_ERROR_MESSAGE_PREFIX assistant message; cancellation returns
//      quietly; honest credential-absent refusals, never a cross-provider
//      fallthrough;
//    - bounded retry: one retry, only for a retryable fault BEFORE content;
//    - usage joins the ONE session ledger (addToTotalSessionCost) and the
//      cache-break detector, exactly like the zai/openai lanes.
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

/** Bounded own retry: one retry, only for a retryable fault BEFORE content. */
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

/** The dispatch-side model id: Mercury's context-suffix annotations
 *  ([1m]/[served]) are client-side dressing on the persisted id and strip
 *  EVERYWHERE — qualified provider namespaces included. No live catalogue
 *  serves bracket ids (the 2026-08-24 probe of the full OpenRouter
 *  catalogue: zero of 417); a bracket inside a namespace is always
 *  Mercury's own toggle dressing, and stripping it is what lets a
 *  legacy-persisted dressed id heal instead of drawing a provider 400.
 *  The qualified prefix itself survives — this id is the ledger/stamp
 *  identity, and transcripts must round-trip onto the same route. */
export function compatDispatchModelId(model: string): string {
  return normalizeModelStringForAPI(model.trim())
}

/** A lane's dispatch credential. `requestUrl` is present when the credential
 *  is valid on a base other than the lane's default — a Kimi sign-in
 *  dispatches on its region's coding base while a Moonshot key rides the
 *  platform base — so the bearer and the host it is valid on travel as ONE
 *  record and can never split across a refresh. */
export interface CompatCredential {
  apiKey?: string
  requestUrl?: string
}

export interface CompatLaneProfile {
  lane: CompatLaneId
  /** Display words for refusals/fault notes ('Moonshot' · 'DeepSeek' · the
   *  operator's compat label). Never carries a secret. */
  providerLabel: string
  /** The lane's dispatch credential; undefined = the honest refusal below.
   *  A present record with apiKey undefined is a KEYLESS dispatch (legal on
   *  the compat slot — local servers). May be ASYNC (fold seam:
   *  the Gemini lane's resolver refreshes its OAuth token before answering —
   *  a profile riding this runtime awaits it per call). */
  resolveCredential(): CompatCredential | undefined | Promise<CompatCredential | undefined>
  /** The refusal text when no credential resolves (names the attach route). */
  credentialHint: string
  /** The exact remedy when the provider REJECTS the credential it was sent
   *  (401/403/invalid-key class): the command that fixes it. Falls back to
   *  credentialHint when absent. */
  authRemedy?: string
  /** The exact remedy when the provider reports the account out of credit
   *  (402 / balance class). */
  billingRemedy?: string
  /** Refresh-on-401 (OAuth families): called ONCE when the provider rejects
   *  the credential before any content — forces a token refresh and answers
   *  the fresh credential; undefined when a refresh was attempted and
   *  produced nothing; NULL when the rejected credential has no refresh
   *  route at all (an API key, a minted key) — then no attempt is reported.
   *  A credential that differs from the rejected one earns exactly one
   *  retried attempt. */
  recoverCredential?(): Promise<CompatCredential | undefined | null>
  /** The lane's chat-completions URL (env fixture seams already applied) —
   *  the default when the credential names no base of its own. */
  requestUrl(): string
  /** The id exactly as it rides the wire (compat strips its prefix). */
  wireModelId(modelId: string): string
  /** Request-fit preflight (the local lane's silent-truncation guard): the
   *  runtime hands the COMPOSED request's real size and the lane answers a
   *  typed refusal when the serving window cannot hold it — a server that
   *  would silently truncate must never be sent the request. Absent = no
   *  check (cloud lanes' windows are the vendor's business). */
  requestFitRefusal?(estimate: { requestBytes: number; estTokens: number; toolCount: number; wireModel: string }): string | undefined
  /** Response-seam hook: rate/usage headers fold into
   *  the lane's usage state (called on every HTTP response, error included —
   *  limit headers matter most on refusals). The status rides beside the
   *  headers so a bare 429 without limit headers can still mark a window. */
  onResponseHeaders?(headers: Headers, status?: number): void
  /** Static request headers the lane documents (never a secret) — e.g. the
   *  organization-billing header the Hugging Face router reads. */
  extraHeaders?(): Record<string, string> | undefined
  /** Servers whose chat surface rejects or ignores tool_choice (Ollama's
   *  OpenAI compatibility lists it unsupported) get the tools without the
   *  selector; every other lane keeps the 'auto' the runtime sends. */
  omitsToolChoice?: boolean
  /** A typed pre-flight refusal for a tool-bearing request on a model whose
   *  server/catalogue states it cannot call tools — the honest answer
   *  instead of a broken turn. Returns the refusal text, or undefined to
   *  proceed. Only consulted when the request carries tools. */
  toolCapabilityRefusal?(wireModel: string): string | undefined
  /** Lane-documented request knobs (effort/thinking/max-tokens spellings). */
  buildExtras(args: {
    wireModel: string
    effortValue: string | undefined
    thinkingEnabled: boolean
    maxOutputTokensOverride: number | undefined
  }): Record<string, unknown>
  /** Return historical assistant reasoning (reasoning_content) to the
   *  provider for this wire model. Documented per-model contracts: Kimi's
   *  Preserved-Thinking models REQUIRE it; DeepSeek forbids returned
   *  reasoning. Absent = omit (today's default for every other lane). */
  keepsReasoningHistory?(wireModel: string): boolean
}

// Session live-proof latches, per lane: readiness paints 'ready' ONLY after a
// real turn settled this session (configured is never painted ready).
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

/** The typed overflow verdict for a fault on a compat lane — the one
 *  classifier owner (services/api/overflowSignal.ts), the lane as the
 *  family word; null for every other fault. */
function overflowOf(
  lane: CompatLaneId,
  fault: Pick<CompatFault, 'code' | 'message'> & { status?: number },
): OverflowSignal | null {
  return classifyOverflowFault({ family: lane, status: fault.status, code: fault.code, message: fault.message })
}

type TypedError = NonNullable<AssistantMessage['error']>

/** Google's status words as the Gemini surfaces spell them in
 *  `error.status` (the google.rpc.Code vocabulary); the details reason
 *  API_KEY_INVALID classifies through the auth vocabulary below. */
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

/** Z.AI's documented numeric table (zai/zaiClient.ts header): 1000-1005
 *  auth · 1113 balance · 1211 unknown model · 1301 sensitive · 1302/1305
 *  rate/overload. */
function zaiCodeClass(code: number): TypedError | undefined {
  if (code >= 1000 && code <= 1005) return 'authentication_failed'
  if (code === 1113) return 'billing_error'
  if (code === 1302 || code === 1305) return 'rate_limit'
  if (code === 1211 || code === 1301) return 'invalid_request'
  return undefined
}

/** The class a vendor's own failure word names, across the vocabularies the
 *  families actually speak; undefined when the code carries no word (a bare
 *  http-NNN) or an unrecognised one. */
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

/** ONE typed mapping from a compat-lane fault to the terminal error category
 *  (the openaiFaultToTypedError sibling): auth ≠ billing ≠ rate limit ≠ bad
 *  request ≠ transport, and no consumer parses prose to tell them apart.
 *  Shared by the zai lane (its fault union is the shape this generalizes).
 *
 *  Order of truth: a vendor word naming one of the SPECIFIC classes (auth ·
 *  billing · rate limit) wins — Gemini answers an invalid key with HTTP 400
 *  + API_KEY_INVALID, Z.AI's balance code rides its own number; then the
 *  HTTP status class every vendor shares (401/403 auth · 402 billing · 429
 *  rate · 408/5xx server · other 4xx invalid request — DeepSeek's and
 *  OpenRouter's 402 are documented balance/credit exhaustion); then any
 *  other vendor word; then the status-less legacy spellings. */
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

/** The terminal refusal text by class: a credential or billing failure
 *  names the provider, the wire's own words, and the EXACT remedy the lane
 *  documents — never a generic "stream failed" for a fixable state. */
export function compatTerminalFaultText(
  profile: Pick<CompatLaneProfile, 'providerLabel' | 'credentialHint' | 'authRemedy' | 'billingRemedy'>,
  fault: Pick<CompatFault, 'code' | 'message'>,
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
    case 'rate_limit':
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} is rate-limiting this account (${detail}) — retry in a moment, or /model picks another model meanwhile.`
    default:
      return `${API_ERROR_MESSAGE_PREFIX}: ${profile.providerLabel} stream failed (${fault.code}) — ${fault.message}`
  }
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

/**
 * The canonical DISJOINT envelope from the family's INCLUSIVE usage (the
 * openai lane's mapOpenaiUsageToAnthropic law, held here for every
 * chat-completions vendor): the cached prefix is counted INSIDE
 * prompt_tokens — OpenAI-compat `prompt_tokens ⊇ prompt_tokens_details.
 * cached_tokens`, DeepSeek `prompt_tokens = prompt_cache_hit_tokens +
 * prompt_cache_miss_tokens` (documented), Moonshot `cached_tokens ⊆
 * prompt_tokens` — while the canonical `input_tokens` is the UNCACHED count
 * beside `cache_read_input_tokens`. Passing the inclusive total through
 * billed the cached prefix twice in every consumer (cost, session ledger,
 * headless usage). cached>total is a provider anomaly: uncached clamps to
 * zero, never negative.
 */
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

/**
 * The provider-aware callModel branch for one OpenAI-compatible lane. Same
 * parameter object and yield union as queryModelWithStreaming.
 */
export async function* compatChatCallModel(
  profile: CompatLaneProfile,
  params: CompatCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, thinkingConfig, tools, signal, options } = params
  const modelId = compatDispatchModelId(options.model)

  // Honest refusal ladder — never a silent fallthrough to another provider.
  // Wire-id truth first: an id the canonicalization owner refuses (display
  // words in an id position, a second vendor prefix composed onto a
  // carrier-shaped id) can never run on ANY credential — it refuses here,
  // catalogue-worded, before a byte reaches the provider.
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
  const effortValue = resolveWireRequestedEffort(modelId, options.effortValue)
  // The one-contract law: resolve the composed behaviour contract and render
  // the GENERIC family — the default contract alone, no other family's
  // overlay (Claude-currency and GPT-delta material never ride these wires).
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
    // The pairing heal runs FIRST: strict chat servers reject tool_calls
    // with no role:'tool' answer — the stopped-mid-turn switch class.
    messages: mapMessagesToZai(systemText, toBridgeMessages(healWalkableForWire(wireMessages), options.querySource), {
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
    // ~3.9 bytes/token measured on this wire's JSON (n_tokens 13126 for a
    // 51KB body); /4 is the conservative floor the check uses.
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
  // The lane FEEDS the shared api-duration ledger (FN-018 rank 11): the
  // final attempt is the api time, the whole loop the wall — the openai
  // lane's shape; these lanes never wrote it, so a DeepSeek or Moonshot
  // session read "Total duration (API)" 0 and duration_api_ms 0.
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
      // The wire served: a billing refusal observed earlier on this lane no
      // longer describes it (the usability owner reads the record).
      recordLaneTurnSettled(profile.lane)
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
        /* accounting must never fail the settled turn */
      }
      return
    }
    if (outcome.kind === 'cancelled') return
    const typed = compatFaultToTypedError(outcome.fault)
    // Refresh-on-401: a credential the provider rejects before any content
    // earns ONE forced refresh on the lanes that can refresh (OAuth token
    // families); a genuinely different credential is retried once, and a
    // second refusal surfaces with the remedy. A clock-skewed or revoked-
    // on-the-server token recovers here without operator intervention.
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
      // null = the credential has no refresh route (a key): nothing was
      // attempted, so the refusal must not claim a refresh was.
      if (fresh !== null) recovery = 'no-new-credential'
    }
    const retryable =
      outcome.retryEligible && outcome.fault.retryable && attempt < COMPAT_MAX_ATTEMPTS
    if (retryable) {
      await new Promise(resolve => {
        const t = setTimeout(resolve, COMPAT_RETRY_BACKOFF_MS * attempt)
        // biome-ignore lint/suspicious/noExplicitAny: unref exists under node
        ;(t as any).unref?.()
      })
      if (signal.aborted) return
      continue
    }
    // THE CREDENTIAL WALL (ledger L25, L23's inline arm): a revoked sign-in
    // or a key past its cap (OpenRouter's 403 "Key limit exceeded") paints
    // the estate's one honest line — credentialWall's owner, the words the
    // concourse's row receipt speaks — and nothing of the wire's payload
    // rides the row (no errorDetails; the debug log keeps it). A reached
    // cap is a credit fact: the usability owner records it with the wall
    // line as the remedy, cleared by the next settled turn like a 402.
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
      // The wire refused this turn for credit: the usability owner marks the
      // lane not usable with the lane's own remedy until a turn settles.
      recordLaneBillingRefusal(profile.lane, {
        detail: outcome.fault.message ? `${outcome.fault.code}: ${outcome.fault.message}` : outcome.fault.code,
        remedy: profile.billingRemedy ?? 'top up the account at the provider, then retry; /model picks another model meanwhile.',
      })
    }
    yield apiErrorMessage(
      compatTerminalFaultText(profile, outcome.fault, typed, recovery ? { recovery } : undefined),
      typed,
      outcome.fault.code,
      overflowOf(profile.lane, outcome.fault),
    )
    return
  }
}

/** One streaming attempt, translated live into the Anthropic-shaped contract
 *  (the zaiCallModel settlement law, held move for move). */
async function* streamOneCompatAttempt(ctx: {
  profile: CompatLaneProfile
  request: CompatChatRequest
  apiKey: string | undefined
  /** The URL this attempt posts to (the credential's own base, else the
   *  lane's default). */
  requestUrl: string
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  messages: Message[]
  pulseMain: boolean
  pulseGeneration: number
  /** The payload plan's predicate: a deferred tool this session has not
   *  admitted — a schema refusal for it names the admission road. */
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
  /** A block settled whole at finish. `decorate` stamps message-level facts
   *  (a refusal record) BEFORE the message is yielded, so every holder of
   *  the reference sees them. */
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
  // A provider-side termination (content filter, resource exhaustion, an
  // unmapped finish word) settles with a VISIBLE note carrying the
  // provider's own reason — the openai lane's other-incomplete law
  // on this dialect: FINISH_TO_STOP maps these to end_turn, so
  // without the note a provider-cut turn reads as the model CHOOSING to
  // stop (the dead-turn silent-stop shape; the run then terminates on the
  // api-error tail with the model never told in-turn). The post-settle
  // apiErrorMessage stays the operator/SDK fault surface; this block is the
  // wire-visible truth the next request carries.
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

  // A finish of 'tool_calls' whose every call was refused settles as
  // end_turn: stop_reason 'tool_use' is only ever true beside a minted block.
  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'stop'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = mapCompatUsageToAnthropic(usageSeen)
  if (!usageSeen && fault !== undefined) {
    // FN-018 rank 4: a stream that faulted after content carries no usage
    // frame, yet the provider billed the request — it joins the ledger at
    // the character estimate (the prompt as sent, the blocks that
    // streamed), never at zero.
    const estimated = estimateFaultedRequestUsage({ lane: profile.lane, model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    // Usage truth: these lanes join the same session usage/cost ledger the
    // Anthropic wire feeds. A provider-STATED cost
    // (OpenRouter's usage accounting) is billing truth and wins over the
    // pin-table derivation — engine ids ledger real USD with zero price pins.
    addToTotalSessionCost(
      usageSeen.statedCostUSD ?? calculateUSDCost(modelId, finalUsage as never),
      finalUsage as never,
      modelId,
      // A wire-stated cost IS a price: the ledger must not count the turn
      // unpriced when the pricing owner happens to hold no rate for the id.
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
      streamFaultAfterPartialText(profile.providerLabel, fault.code, fault.message),
      compatFaultToTypedError(fault),
      fault.code,
      overflowOf(profile.lane, fault),
    )
  }
  return { kind: 'done' }
}
