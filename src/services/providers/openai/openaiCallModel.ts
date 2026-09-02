// ============================================================================
//  providers/openai/openaiCallModel — the native OpenAI GPT in-process model
//  runtime: the provider-aware branch behind
//  QueryDeps.callModel for gpt-* ids.
//
//  This generator speaks queryModelWithStreaming's EXACT yield contract
//  (turn-machine.ts consumes it at run.deps.callModel) — the same contract
//  the zai sibling (zaiCallModel.ts) established:
//
//    - `{type:'stream_event', event}` per Mercury stream part (the
//      types/wire.ts grammar: message_start · content_block_start/delta/stop
//      · message_delta · message_stop), so the existing fan-out//
//      transcript machinery is untouched — and NO provider-SDK intermediate
//      exists on this lane;
//    - ONE AssistantMessage per settled content block; final usage +
//      stop_reason written back onto the LAST yielded message by DIRECT
//      MUTATION (the transcript write queue holds the reference);
//    - provider trouble NEVER throws: terminal faults yield an
//      API_ERROR_MESSAGE_PREFIX assistant message; cancellation returns
//      quietly.
//
// -specific laws (decisions #1-#5):
//    - honest refusal ladder: no account source · qualification failure
//      (not in the live catalogue / hidden) — never a silent fallthrough to
//      another provider;
//    - reasoning effort resolves through the LIVE per-model catalogue
//      (resolveGptReasoningProfile) — an unsupported requested level is
// ADJUSTED WITH A VISIBLE NOTE, never silently clamped;
//      a transiently unavailable catalogue omits the effort key (server-side
//      model default) and says so;
//    - STATELESS REPLAY (decision #4): requests are self-contained
//      (store:false + encrypted reasoning include); at settlement the turn's
//      ordered output items land on the last minted message as
//      apexProviderTurn (direct mutation — the transcript holds the
//      reference), and the provider response id rides it for receipts only;
//    - GPT reasoning-summary deltas stream live as thinking blocks; tool
//      calls settle EXACTLY ONCE at finish; malformed calls degrade to
//      visible text notes; refusal deltas stream as visible text.
// ============================================================================
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


// Session live-proof latch: readiness paints openai 'ready' ONLY after a real
// turn settled this session (configured is never painted ready — zai parity).
let openaiLiveProof: { at: number; model: string } | null = null
export function openaiLiveProofState(): { at: number; model: string } | null {
  return openaiLiveProof
}

/** Bounded own retry: one retry, only for a retryable fault BEFORE content. */
const OPENAI_MAX_ATTEMPTS = 2
const OPENAI_RETRY_BACKOFF_MS = 400

/** the pure retry-delay law — provable arithmetic, one owner. */
export function openaiRetryDelayMs(attempt: number): number {
  return OPENAI_RETRY_BACKOFF_MS * attempt
}

/** ONE typed mapping from the wire fault to the terminal
 *  error category — refusal ≠ account limit ≠ auth ≠ rate limit ≠ transport
 *  ≠ cancel ≠ success, and no consumer parses prose to tell them apart.
 *  (Refusal/content-filter is a CONTENT outcome via finish reason, never an
 *  error; cancellation returns without a message.) */
export function openaiFaultToTypedError(
  fault: Pick<import('./openaiWire.js').OpenaiFault, 'kind' | 'code'> & { status?: number },
): NonNullable<AssistantMessage['error']> {
  if (fault.kind === 'usage-limit') return 'rate_limit'
  // The HTTP status class is the floor (a 404 model_not_found is a bad
  // request, not a server fault); the code word refines within it.
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

/** The typed overflow verdict for a wire fault on this lane — the one
 *  classifier owner (services/api/overflowSignal.ts); null for every other
 *  fault. */
function overflowOf(fault: { status?: number; code: string; message: string }): OverflowSignal | null {
  return classifyOverflowFault({ family: 'openai', status: fault.status, code: fault.code, message: fault.message })
}

/** Raw messages → bridge rows: message-param content (the SAME converters the
 *  Anthropic wire uses) + the turn id and the decoded replay record for
 *  assistant rows (stateless replay reads BOTH).
 *
 * Reconstruction accounting counts ONLY GPT-served turns that SETTLED
 *  (stop_reason written back) yet carry no replay record — genuinely
 *  pre-capture history. Interrupted partials are recordless BY DESIGN (the
 *  cancel path never reaches the finish write-back, so stop_reason stays
 *  null on every row) and derive silently — an everyday Esc must not print a
 *  "predates reasoning capture" receipt (live-found, the Luna
 *  interrupt → Sol switch). Anthropic/GLM turns never count.
 *
 *  Cross-model guard: a replay record minted by a DIFFERENT gpt model than
 *  the one this request targets is dropped (content derivation instead —
 *  the same lawful path Anthropic rows take). Encrypted reasoning items are
 *  model-bound; replaying Luna's items into a Sol request is a provider-400
 *  class, and a model switch is a deliberate operator act, not a
 *  reconstruction event. */
export function toBridgeMessages(
  messages: Message[],
  querySource: Options['querySource'],
  targetModelId: string,
): { rows: BridgeMessage[]; reconstructedGptTurns: number } {
  const out: BridgeMessage[] = []
  const target = targetModelId.trim().toLowerCase()
  // Per-TURN facts (a settled multi-block turn carries its record and its
  // stop_reason only on the LAST row — per-row accounting miscounted every
  // recorded turn's text rows as "recordless" and fired a bogus receipt in
  // every session's first follow-up call; live-found).
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
    // progress/tool_use_summary rows are parent-side furniture on every
    // wire. Attachment and local_command system rows are NOT: the heal
    // (healWalkableForWire → projectEnvelopeRowsForWire) projects them into
    // user rows before this bridge runs — the same content the Anthropic
    // planner delivers — so by here the walkable set is user/assistant only.
  }
  let reconstructed = 0
  for (const id of gptTurnIds) {
    if (settledTurnIds.has(id) && !recordedTurnIds.has(id)) reconstructed += 1
  }
  return { rows: out, reconstructedGptTurns: reconstructed }
}

/** Once-per-thread latch for the reconstructed-continuation receipt. */
const reconstructionNoted = new Set<string>()

/** The role THIS turn runs as (the receipt it mints): a call that tags its
 *  own seat (the Concourse coordinator's query source) names it outright;
 *  otherwise role env stamps win (daemon children carry exactly one);
 *  agent-scoped turns are specialists; the foreground is primary. */
function activeApexRole(options: Options): ApexGptRole {
  if (options.querySource === 'concourse_coordinator') return 'coordinator'
  if (flagEnv('MERCURY_IMPLEMENTER') === '1') return 'scribe-implementer'
  if (flagEnv('MERCURY_SCRIBE') === '1') return 'scribe-router'
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
 * normalize OpenAI's INCLUSIVE usage to the canonical
 * DISJOINT envelope ONCE, at this adapter boundary. OpenAI's `input_tokens`
 * CONTAINS `cached_tokens`; the canonical (Anthropic-spelled) envelope reads
 * `input_tokens` as uncached-beside-`cache_read_input_tokens`. The verbatim
 * mapping double-counted the cached prefix in every consumer — cost, session
 * ledger, headless JSON (the field specimen re-priced $3.715109 → the
 * correct disjoint $2.296869). cached>total is a provider anomaly: uncached
 * clamps to 0 (never negative), and the raw inclusive totals survive in the
 * attached provider receipt (buildProviderUsageReceipt) — never in the
 * canonical fields.
 */
export function mapOpenaiUsageToAnthropic(usage: OpenaiUsage | undefined, webSearchRequests = 0): typeof EMPTY_USAGE {
  const total = usage?.inputTokens ?? 0
  const cached = usage?.cachedInputTokens ?? 0
  return {
    ...EMPTY_USAGE,
    input_tokens: Math.max(0, total - cached),
    output_tokens: usage?.outputTokens ?? 0,
    cache_read_input_tokens: cached,
    // The hosted searches the wire collected (one server_tool_use block is
    // minted per call) ride the envelope's counter, so the ledger fold and
    // the exit-summary metric see them (FN-018 rank 18: the counter stayed
    // 0 and the metric silently vanished for GPT sessions that searched).
    // Pricing is a separate, recorded decision — the pinned engines carry
    // no per-search rate (modelCost).
    server_tool_use: { ...EMPTY_USAGE.server_tool_use, web_search_requests: webSearchRequests },
  }
}

/** The receipt-only raw provider totals — inclusive semantics survive
 *  HERE and only here, with the reasoning-token detail and the
 *  cached>total anomaly marker. */
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

/**
 * The replay record minus every call Mercury refused: a replayed
 * function_call must be answered by a function_call_output, and a refused
 * call never gets one (the call/output pairing law — the fold already drops
 * JSON-malformed calls; the schema gate's refusals leave here). A reasoning
 * item only replays with the item it reasons about — a reasoning item left
 * trailing, or stacked on another, is dropped with its call (the provider
 * rejects a reasoning item "without its required following item").
 */
export function replayableItems(
  orderedItems: readonly OpenaiInputItem[],
  refused: readonly (Pick<RefusedToolCall, 'id'> & { code?: RefusedToolCall['code'] })[],
): OpenaiInputItem[] {
  // A duplicate-id refusal names an id whose FIRST call ran: that call
  // replays, and only the later same-id items leave (one output per id).
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

/** The model resolution + qualification step's product. */
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
  // The 'gpt' class alias resolves to the highest-priority QUALIFIED
  // candidate — the class dispatch never invents an id.
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
    // Transient catalogue trouble must not brick an explicitly-named model:
    // proceed WITHOUT a live effort vocabulary (the reasoning key is omitted
    // — the server-side model default applies) and say so.
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

/**
 * The provider-aware callModel branch for OpenAI GPT. Same parameter object
 * and yield union as queryModelWithStreaming — turn-machine.ts consumes both
 * interchangeably.
 */
export async function* openaiCallModel(
  params: OpenaiCallModelParams,
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {
  const { messages, systemPrompt, tools, signal, options } = params
  const requestedId = normalizeModelStringForAPI(options.model).trim().toLowerCase()

  // Honest refusal ladder — never a silent fallthrough to another provider.
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
  // the request input rides the ONE resolution owner
  // (env MERCURY_EFFORT_LEVEL wins; 'auto'/'unset' defer to the model
  // default; else the turn-floored appState value). The raw options value
  // skipped the env layer entirely, so an env pin steered the Anthropic wire
  // and the display while this wire ran the session value.
  const requestedEffort = resolveWireRequestedEffort(modelId, options.effortValue)
  const profile: GptReasoningProfile = candidate
    ? resolveGptReasoningProfile(requestedEffort, candidate.live)
    : { source: 'model-default' }
  // Rule 2 — an adjusted effort is VISIBLE, never silent. Notes settle as
  // transcript text blocks at settlement (the zai malformed-call channel).
  const settlementNotes: string[] = []
  if (profile.source === 'unsupported-fallback' && profile.adjustedFrom) {
    settlementNotes.push(
      `[openai] requested reasoning effort '${profile.adjustedFrom}' is not in ${modelId}'s live effort catalogue — using '${profile.wireEffort ?? 'the model default'}'.`,
    )
  }
  if (qualification.kind === 'degraded') {
    settlementNotes.push(qualification.note)
  }

  // Reconstructed continuation (A7): GPT turns predating reasoning
  // capture replay from transcript content — VISIBLE once per thread, benign.
  // The pairing heal runs FIRST: a stopped-mid-turn transcript carries an
  // orphaned tool_use, and the Responses API refuses an unanswered
  // function_call — the switched-family pickup class.
  const bridge = toBridgeMessages(healWalkableForWire(wireMessages), options.querySource, modelId)
  const threadKey = `${getSessionId()}:${options.agentId ?? 'main'}`
  if (bridge.reconstructedGptTurns > 0 && !reconstructionNoted.has(threadKey)) {
    reconstructionNoted.add(threadKey)
    settlementNotes.push(
      `[openai] reconstructed continuation: ${bridge.reconstructedGptTurns} earlier GPT turn(s) predate reasoning capture — their content replays from the Mercury transcript (benign; new turns record full replay items).`,
    )
  }

  // A3 behaviour contract (the typed section pipeline resolves
  // this composition and renders the OpenAI instructions — the same canonical
  // sections minus Anthropic-only material; the contract digest rides the
  // turn record for receipts.
  const contract = resolveBehaviourContract([...systemPrompt])
  // NO max_output_tokens on the wire — live-proved: the
  // subscription route 400s 'Unsupported parameter'; the reference request
  // omits it too. Output bounding is server-side per model (128K family cap).
  // the prompt cache key is the
  // opaque STABLE cache-domain digest — fresh compatible processes mint the
  // SAME key and reuse the provider cache; any real compatibility change
  // (model · project · contract · tools · source kind) moves it. The old
  // session-scoped spelling guaranteed a cold cache per process.
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
    // A4: images ride as input_image when the LIVE modality list admits them
    // (every current 5.6 model does); an unknown/absent list stays permissive
    // — the wire's own error is the honest signal for a truly text-only model.
    imagesSupported: candidate?.live.inputModalities
      ? candidate.live.inputModalities.includes('image')
      : true,
    //  parity: a JSON-schema-forced call rides the SAME format
    // truth the Anthropic wire's output_config.format carries.
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    // The neutral native-search request in THIS wire's spelling (the
    // hosted web_search tool) — set only by the search door for an openai
    // session.
    ...(options.nativeWebSearch ? { nativeWebSearch: options.nativeWebSearch } : {}),
  })

  // Cache-break phase 1: the GPT lane's wire prompt state — the
  // rendered instructions + the API-shaped tool schemas.
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

  // the openai lane FEEDS the shared api-duration
  // ledger — a sol turn must not report duration_api_ms 0 in the headless
  // envelope while only the Anthropic lane records durations.
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
      // 0 < api ≤ wall by construction — the final attempt's duration
      // is the api time, the whole loop (incl. retries/backoffs) the wall.
      try {
        const { logAPISuccessAndDuration } = await import('../../api/logging.js')
        logAPISuccessAndDuration({ start: attemptStartedAtMs, startIncludingRetries: turnStartedAtMs })
      } catch {
        /* accounting must never fail the settled turn */
      }
      openaiLiveProof = { at: Date.now(), model: modelId }
      recordLaneTurnSettled('openai')
      // A8: the qualification receipt is minted from THIS observed live
      // settlement — digest-tied (adapter · role capability · behaviour
      // contract · epoch), persisted best-effort at the auth scope.
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
    // Refresh-on-401 for the subscription source: a token the local clock
    // vouched for was refused (skew, server-side revocation) — force ONE
    // refresh and retry once with a genuinely different token; a second
    // refusal surfaces with the remedy. A key has nothing to recover.
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
        // biome-ignore lint/suspicious/noExplicitAny: unref exists under node
        ;(t as any).unref?.()
      })
      if (signal.aborted) return
      continue
    }
    if (outcome.fault.kind === 'usage-limit') {
      // A7 honest usage-limit UX: name the SOURCE whose
      // window is reached, the reset facts when the provider stated them,
      // and the real next actions — never a silent cross-provider or
      // cross-source reroute, never the Anthropic credential relay.
      recordOpenaiUsageLimit(outcome.fault.resetsAtMs, auth.account.kind)
      // The wall row's slot appendix: when the OTHER OpenAI
      // slot is signed in with headroom, the wall arrives as an OFFER in
      // words (the composer's card is the one key; posture auto is named
      // here as the transcript receipt of the unattended switch).
      const slotAppendix = ((): string => {
        try {
          const { slotWallAppendix } =
            require('../slotSwitch.js') as typeof import('../slotSwitch.js')
          return slotWallAppendix('openai')
        } catch {
          return ''
        }
      })()
      yield apiErrorMessage(
        `${API_ERROR_MESSAGE_PREFIX}: the ${auth.account.label} usage window is reached (${outcome.fault.code}) — ${outcome.fault.message}. GPT work on this source pauses until it resets; Mercury never reroutes across providers, and never changes the account source without your word.${slotAppendix || ' Options: retry later · pick another model via /model · switch the OpenAI source explicitly (/router source).'}`,
        openaiFaultToTypedError(outcome.fault),
        // code-first machine detail — consumers read the typed error +
        // this stable string, never the human prose above.
        `${outcome.fault.code}${outcome.fault.resetsAtMs !== undefined ? ` resets_at=${new Date(outcome.fault.resetsAtMs).toISOString()}` : ''}`,
      )
      return
    }
    // A credential or billing refusal names the source, the wire's own
    // words, and the exact remedy — never a generic "stream failed" for a
    // fixable state (the compat runtime's compatTerminalFaultText law).
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
      // The usability owner marks the lane not usable until a turn settles.
      recordLaneBillingRefusal('openai', {
        detail,
        remedy: 'add credit to the OpenAI account, then retry; /model picks another model meanwhile.',
      })
    }
    yield apiErrorMessage(text, typed, outcome.fault.code, overflowOf(outcome.fault))
    return
  }
}

/** One streaming attempt, translated live into the Anthropic-shaped contract.
 *  Exported for the 3.5.1 grammar provers ONLY — production entry is
 *  openaiCallModel; `_eventsForTesting` substitutes the SSE fold's event
 *  stream so the translation is provable without a network. */
export async function* streamOneOpenaiAttempt(ctx: {
  /** Prover seam: replaces streamOpenaiResponses when provided. */
  _eventsForTesting?: AsyncIterable<OpenaiStreamEvent>
  request: OpenaiResponsesRequest
  auth: OpenaiRequestAuth
  signal: AbortSignal
  tools: Tools
  options: Options
  modelId: string
  /** The input history — cache-break phase 2's TTL-timing heuristic. */
  messages: Message[]
  /** Adjustment/degradation notes to settle visibly with the turn. */
  settlementNotes: readonly string[]
  pulseMain: boolean
  pulseGeneration: number
  /** The A3 behaviour-contract digest — rides the turn record (receipts). */
  contractDigest: string
  /** The payload plan's predicate: a deferred tool this session has not
   *  admitted — a schema refusal for it names the admission road. */
  deferredUnadmitted?: (name: string) => boolean
}): AsyncGenerator<StreamEvent | AssistantMessage, AttemptOutcome> {
  const { request, auth, signal, tools, options, modelId } = ctx

  // The partialMessage streamCore builds at message_start — usage zeros and
  // stop_reason null until the finish write-back.
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
  // honest across those calls for the type system (zai precedent).
  const blocks = {
    index: -1,
    open: null as
      | { kind: 'thinking' | 'text'; value: string }
      | {
          // 3.5.1: a LIVE tool block — argument bytes paint as
          // input_json_delta while the provider streams them. Paint only:
          // the authoritative tool_use mints once at validated terminal
          // settlement; `bytes` tracks painted length so a
          // done-carried body knows it was never visible.
          kind: 'tool'
          itemId: string
          callId: string
          name: string
          bytes: number
        }
      | null,
  }
  // 3.5.1: call ids whose live block closed CLEANLY at its done event —
  // their bytes are fully painted, so settlement mints without replaying the
  // body as a second visible delta. A force-closed live block (spec-violating
  // interleave) is absent here and takes the settled replay path instead.
  const livePaintComplete = new Set<string>()
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
      // A live tool block closes WITHOUT minting: the authoritative tool_use
      // settles once from the validated done item — a half-streamed
      // call (fault/interrupt mid-arguments) leaves no executable residue
      // just a closed paint block.
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
  // Pre-known notes (reconstruction receipt · effort adjustment · degraded
  // qualification) LEAD the message — a tail-positioned note becomes the
  // whole headless `result` (live-found on the Sol→Luna switch). Emitted
  // lazily at first content so a pre-content fault still retries cleanly.
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
        // A refusal IS the model's user-facing message — stream it visibly.
        yield* streamDelta('text', event.text)
        break
      case 'tool-args-start': {
        // open the live tool block the moment the provider names the
        // call — the field's 328s of recorded silence becomes first visible
        // tool-input activity at the first provider byte.
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
            // The arguments were done-carried (no deltas streamed) — paint
            // them now, exactly once: first visibility, not a replay.
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
          // Total over every finish arm: the unmapped-INCOMPLETE mint carries
          // no web-search/citation arrays, and the settle path must read them
          // without dying (S5 — settles visibly, never silently).
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
    // A clean pre-content failure — eligible for the bounded retry.
    return { kind: 'fault', fault, retryEligible: true }
  }

  // ── Settlement ────────────────────────────────────────────────────────────
  yield* ensureMessageStart()
  yield* closeOpenBlock()
  yield* emitLeadingNotes()

  // The transport-boundary gate (../toolCallGate.ts): a tool_use block mints
  // ONLY for a call in the catalog whose settled arguments satisfy the
  // tool's schema; every other call settles as a visible note carrying its
  // typed refusal, which the turn machine hands back to the model.
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
      // the bytes are already fully painted live — settlement mints the
      // ONE authoritative tool_use without replaying the body as a second
      // visible delta.
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
      // The provider call id IS the block id — tool_results answer it and the
      // bridge replays it as the function_call/function_call_output pairing.
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
    // Hosted searches settle in the Mercury stream grammar the search leg
    // folds on every wire: one server_tool_use per search, then ONE
    // web_search_tool_result carrying the answer's citations as hits
    // (the wire attributes citations to the answer, not to a call — they
    // ride under the last call's id).
    // Both blocks travel WHOLE in their start event, as the Anthropic wire
    // delivers them — progress readers count the hits at the start event.
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
    // A response.incomplete whose reason Mercury does not map would
    // otherwise settle as a SILENT end_turn — the model looks like it chose
    // to stop mid-task (the dead-turn incident's silent-stop shape). The
    // note carries the provider's own words so the operator and the model
    // both see the turn was cut, not finished.
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
    // Zero content settled (degenerate stream) — mint one empty text block so
    // the loop always receives an assistant settlement.
    yield* emitSettledBlock(
      { type: 'text', text: '', citations: null },
      [],
      { type: 'text', text: '', citations: null },
    )
  }

  // A 'tool_calls' finish whose every call was refused settles as end_turn:
  // stop_reason 'tool_use' is only ever true beside a minted block.
  const mappedFinish = FINISH_TO_STOP[finish?.reason ?? 'completed'] ?? 'end_turn'
  const stopReason =
    accepted.length > 0 ? 'tool_use' : mappedFinish === 'tool_use' ? 'end_turn' : mappedFinish
  const finalUsage = mapOpenaiUsageToAnthropic(usageSeen, finish?.webSearchCalls.length ?? 0)
  if (!usageSeen && fault !== undefined) {
    // FN-018 rank 4: a stream that faulted after content carries no usage
    // frame, yet the provider billed the request — it joins the ledger at
    // the character estimate, never at zero.
    const estimated = estimateFaultedRequestUsage({ lane: 'openai', model: modelId, request, minted, faultCode: fault.code })
    addToTotalSessionCost(calculateUSDCost(modelId, estimated), estimated, modelId)
  }
  if (usageSeen) {
    // Usage truth (A7): GPT turns join the SAME session usage/cost
    // ledger the Anthropic wire feeds (modelUsage keyed by the served id;
    // USD at the official published rates — an estimate, the Anthropic-
    // subscription precedent; live-found: headless modelUsage was
    // EMPTY for GPT turns before this).
    addToTotalSessionCost(
      calculateUSDCost(modelId, finalUsage as never),
      finalUsage as never,
      modelId,
    )
  }
  // Cache-break phase 2: the GPT lane maps cached prompt tokens
  // into the same usage spelling — fire-and-forget, never blocks the lane.
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
    // Direct mutation keeps in-memory holders current; the durable record
    // is settled explicitly below — settlement and the
    // stateless-replay receipt become durable together, atomically.
    lastMessage.message.usage = finalUsage as AssistantMessage['message']['usage']
    lastMessage.message.stop_reason = stopReason as AssistantMessage['message']['stop_reason']
    const replayItems = replayableItems(finish?.orderedItems ?? [], refused)
    if (replayItems.length > 0) {
      // The stateless-replay record (decision #4): the turn's ordered wire
      // items + the response id (receipts only, never chaining).:
      // the provider's raw INCLUSIVE usage rides the same receipt — the
      // canonical envelope above is disjoint, and no consumer re-derives
      // from provider semantics.
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
    // Content settled but the stream faulted — surface it after settlement
    // through the SHARED continuable-class composer: the turn machine's
    // bounded stream-fault recovery keys on this exact marker.
    yield apiErrorMessage(
      streamFaultAfterPartialText('OpenAI', fault.code, fault.message),
      undefined,
      undefined,
      overflowOf(fault),
    )
  }
  return { kind: 'done' }
}
