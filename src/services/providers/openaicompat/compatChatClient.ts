// ============================================================================
//  providers/openaicompat/compatChatClient — the SHARED OpenAI-compatible
//  chat-completions streaming client.
//
//  ONE transport for every lane that speaks the chat-completions SSE dialect:
//  Moonshot/Kimi, DeepSeek
// and the operator-named
//  OpenAI-compatible endpoint slot (vLLM · LM Studio · Ollama · proxies —
//  the shape those servers all serve). The Z.AI lane keeps its own proven
//  client (zaiClient.ts, the module this generalizes): its numeric error
//  table and finish_reason failure channel are Z.AI-specific.
//
//  Laws (zaiClient's laws, held verbatim):
//    - rides the existing HTTP owners (getApiFetch + getProxyFetchOptions +
//      getUserAgent); own bounded idle watchdog + AbortSignal cancellation;
//      NEVER the Anthropic OAuth/keychain machinery;
//    - typed events out, faults as data; the [DONE] sentinel closes the
//      stream; a stream ending without finish_reason or [DONE] is a typed
//      truncation fault;
//    - tool-call deltas are index-keyed fragments accumulated EXACTLY ONCE;
//      a call whose accumulated arguments fail to parse is a typed
//      malformed-tool-call, never a silent half-call;
//    - the key comes from the caller and never enters logs or error text; a
//      keyless call is legitimate on the compat slot (local servers).
//
//  Usage decode reads every documented cached-prefix spelling in one place —
//  the fields are disjoint per provider:
//    · OpenAI-compat standard — usage.prompt_tokens_details.cached_tokens;
//    · Moonshot — top-level usage.cached_tokens;
//    · DeepSeek — usage.prompt_cache_hit_tokens (+ _miss_tokens).
//
//  finish_reason handling: stop|tool_calls|length settle normally;
//  content_filter and insufficient_system_resource (DeepSeek's documented
//  overload channel — retryable) surface as typed provider-termination
//  faults AND still settle what arrived; an UNRECOGNIZED value settles as
//  end_turn with the raw string preserved on the finish event — a new vendor
//  word must never masquerade as a truncated stream.
// ============================================================================
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { SseDecoder } from '../sseDecoder.js'
import { compatStreamIdleTimeoutMs } from '../streamIdleBudget.js'

// The byte-idle guard's budget: the one stream idle owner's default
// (providers/streamIdleBudget), so the status row and this guard agree.
const IDLE_TIMEOUT_MS = compatStreamIdleTimeoutMs()
/** Hard whole-request ceiling (the zaiClient figure — long thinking turns). */
const TOTAL_TIMEOUT_MS = 50 * 60_000

// ── Request shapes (the OpenAI-compatible wire; structurally identical to
//    the zaiClient request family — zaiCodec's message mapping feeds both) ──

export interface CompatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: CompatToolCall[]
  tool_call_id?: string
}

export interface CompatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface CompatTool {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

export interface CompatChatRequest {
  model: string
  messages: CompatMessage[]
  tools?: CompatTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  /** Lane-specific passthrough knobs (max_tokens vs max_completion_tokens,
   *  thinking, reasoning_effort, temperature, stream_options …) — the lane
   *  builders own which spellings their provider documents. */
  extra?: Record<string, unknown>
}

// ── Typed stream events ─────────────────────────────────────────────────────

export type CompatFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'insufficient_system_resource'
  | 'other'

export interface CompatUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
  /** Provider-stated USD for the turn (OpenRouter usage accounting,
   *  openrouter.ai/docs/use-cases/usage-accounting, fetched:
   *  usage is always included and carries `cost`). Billing truth stated by
   *  the wire — never derived from pinned prices. */
  statedCostUSD?: number
}

export interface CompatCompletedToolCall {
  index: number
  id: string
  name: string
  argumentsRaw: string
  arguments?: unknown
  malformed: boolean
}

export type CompatStreamEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-fragment'; index: number; id?: string; name?: string; argumentsFragment: string }
  | { type: 'usage'; usage: CompatUsage }
  | {
      type: 'finish'
      reason: CompatFinishReason
      /** The provider's raw finish_reason string (reason 'other' keeps the
       *  vendor word visible instead of erasing it). */
      rawReason: string
      toolCalls: CompatCompletedToolCall[]
    }
  | { type: 'stream-fault'; fault: CompatFault }

export interface CompatFault {
  kind:
    | 'http-error'
    | 'api-error'
    | 'provider-termination'
    | 'truncated-stream'
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
  /** Stable, code-first detail (e.g. 'http-401', 'api-API_KEY_INVALID',
   *  'finish:content_filter', 'idle-timeout'). Never carries the key. */
  code: string
  message: string
  retryable: boolean
  /** The HTTP status when the fault came from a response (the typed error
   *  classifier reads it first — a vendor's code word refines, never
   *  replaces, the status class). */
  status?: number
}

// ── Error mapping (the generic HTTP table; lanes may refine via profile) ───

/** The vendor's own word for the failure, across the envelopes the compat
 *  family actually serves:
 *    · OpenAI-style `error.code` string ('invalid_api_key');
 *    · Google-style numeric `error.code` + `error.status` word
 *      ('UNAUTHENTICATED') + `error.details[].reason` ('API_KEY_INVALID' —
 *      the most specific, so it wins when present);
 *    · OpenAI/Moonshot-style `error.type` ('invalid_authentication_error')
 *      when no code word rides;
 *    · OpenRouter's numeric `error.code` (= the HTTP status) with
 *      `error.metadata.provider_code` — the status carries the class.
 *  Undefined when the envelope names nothing beyond the status. */
function vendorErrorWord(err: Record<string, unknown> | undefined): string | undefined {
  if (!err) return undefined
  const details = Array.isArray(err.details) ? err.details : []
  for (const d of details) {
    const rec = typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : undefined
    if (typeof rec?.reason === 'string' && rec.reason !== '') return rec.reason
  }
  if (typeof err.code === 'string' && err.code !== '') return err.code
  if (typeof err.status === 'string' && err.status !== '') return err.status
  if (typeof err.type === 'string' && err.type !== '') return err.type
  return undefined
}

/**
 * Name a transport failure from the runtime's own cause chain (FC-065):
 * five structurally different endpoint failures — bad port, NXDOMAIN,
 * connection refused, TLS onto plain HTTP — all printed the same 88 bytes
 * ("fetch failed") while node held the errno, syscall and address at the
 * throw site. The chain is walked to its deepest cause; the endpoint host
 * is named so the operator knows WHICH configured URL failed.
 */
export function describeTransportFailure(error: unknown, baseURL: string | undefined): string {
  const parts: string[] = []
  let node: unknown = error
  let depth = 0
  while (node instanceof Error && depth < 6) {
    const errno = node as NodeJS.ErrnoException & { hostname?: string; address?: string; port?: number }
    const facts = [
      errno.code,
      errno.syscall,
      errno.hostname ?? errno.address,
      errno.port !== undefined ? String(errno.port) : undefined,
    ].filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (facts.length > 0) parts.push(facts.join(' '))
    else if (node.message && node.message !== 'fetch failed') parts.push(node.message)
    // AggregateError (Happy Eyeballs): the first inner error carries the errno.
    const aggregate = (node as { errors?: unknown[] }).errors
    node = aggregate && aggregate.length > 0 ? aggregate[0] : (node as { cause?: unknown }).cause
    depth++
  }
  const chain = [...new Set(parts)].join(' ← ')
  const host = (() => {
    try {
      return baseURL !== undefined && baseURL !== '' ? new URL(baseURL).host : undefined
    } catch {
      return baseURL
    }
  })()
  const base = error instanceof Error ? error.message : String(error)
  const detail = chain.length > 0 ? chain : base
  return host !== undefined ? `${detail} (endpoint ${host})` : detail
}

export function mapCompatHttpFailure(status: number, body: unknown): CompatFault {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  const err = typeof o?.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : undefined
  // Some servers answer {"error": "<text>"} (the Hugging Face router's 401
  // and Ollama's native errors, both observed) — the string IS the message.
  const stringError = typeof o?.error === 'string' && o.error.trim() !== '' ? o.error : undefined
  const message = String(err?.message ?? stringError ?? o?.message ?? `HTTP ${status}`)
  const word = vendorErrorWord(err)
  return {
    kind: word !== undefined ? 'api-error' : 'http-error',
    code: word !== undefined ? `api-${word}` : `http-${status}`,
    message,
    // 408 is a request timeout on the OpenRouter wire (documented) — a
    // retry is the honest answer, exactly as for 429 and 5xx.
    retryable: status === 429 || status === 408 || status >= 500,
    status,
  }
}

// ── The streaming call ──────────────────────────────────────────────────────

export interface CompatStreamOptions {
  /** Absent is legitimate on the compat slot (local servers auth-free). */
  apiKey?: string
  /** The full chat-completions URL (lane-resolved; fixture seams pin it). */
  url: string
  request: CompatChatRequest
  signal?: AbortSignal
  /** Proof seam — fixtures inject a fake fetch; production uses getApiFetch. */
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
  /** Extra static headers a lane documents (never a secret). */
  extraHeaders?: Record<string, string>
  /** Response-seam hook: rate/usage headers fold into lane usage state
   *  (invoked on every response, error statuses included). */
  onResponseHeaders?: (headers: Headers, status?: number) => void
}

interface ToolCallAccumulator {
  index: number
  id?: string
  name?: string
  argumentsRaw: string
}

/** The slot a tool_call delta accumulates into. The wire's own `index`
 *  wins; without one (servers that omit it), a delta carrying an id joins
 *  the slot already holding that id or opens a new one; a name-only delta
 *  continues the latest slot when the name agrees (vendors that repeat the
 *  name on every fragment) and opens a new one otherwise; a bare arguments
 *  fragment continues the latest slot. Index-less parallel calls never
 *  merge into one. */
function toolCallSlot(
  acc: Map<number, ToolCallAccumulator>,
  index: number | undefined,
  id: string | undefined,
  name: string | undefined,
): number {
  if (index !== undefined) return index
  const slots = [...acc.values()]
  const fresh = (): number => (slots.length === 0 ? 0 : Math.max(...slots.map(s => s.index)) + 1)
  if (id !== undefined) {
    const owner = slots.find(s => s.id === id)
    return owner ? owner.index : fresh()
  }
  const last = slots.at(-1)
  if (!last) return 0
  if (name !== undefined && last.name !== undefined && last.name !== name) return fresh()
  return last.index
}

function finalizeToolCalls(acc: Map<number, ToolCallAccumulator>): CompatCompletedToolCall[] {
  const out: CompatCompletedToolCall[] = []
  for (const a of [...acc.values()].sort((x, y) => x.index - y.index)) {
    let parsed: unknown
    let malformed = false
    const raw = a.argumentsRaw.trim() === '' ? '{}' : a.argumentsRaw
    try {
      parsed = JSON.parse(raw)
    } catch {
      malformed = true
    }
    if (!a.id || !a.name) malformed = true
    out.push({
      index: a.index,
      id: a.id ?? `missing-id-${a.index}`,
      name: a.name ?? '',
      argumentsRaw: a.argumentsRaw,
      ...(malformed ? {} : { arguments: parsed }),
      malformed,
    })
  }
  return out
}

/** Stream one chat completion as typed events. NEVER throws for provider or
 *  transport trouble — faults are events. */
export async function* streamCompatChat(
  options: CompatStreamOptions,
): AsyncGenerator<CompatStreamEvent> {
  const { request } = options
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()

  const toolAcc = new Map<number, ToolCallAccumulator>()
  let finished = false

  try {
    let response: Response
    try {
      const fetchImpl = options.fetchImpl ?? getApiFetch()
      const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
      const { extra, ...core } = request
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          'user-agent': getUserAgent(),
          ...(options.extraHeaders ?? {}),
        },
        body: JSON.stringify({ ...core, ...(extra ?? {}), stream: true }),
        signal: controller.signal,
        ...(proxyOptions as Record<string, unknown>),
      } as RequestInit)
    } catch (error) {
      const cancelled = options.signal?.aborted === true
      yield {
        type: 'stream-fault',
        fault: cancelled
          ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled before response', retryable: false }
          : {
              kind: 'transport-error',
              code: 'fetch-failed',
              message: describeTransportFailure(error, options.url),
              retryable: true,
            },
      }
      return
    }

    try {
      options.onResponseHeaders?.(response.headers, response.status)
    } catch {
      /* usage folding must never break the stream */
    }
    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      yield { type: 'stream-fault', fault: mapCompatHttpFailure(response.status, body) }
      return
    }
    if (!response.body) {
      yield {
        type: 'stream-fault',
        fault: { kind: 'transport-error', code: 'no-body', message: 'response had no body', retryable: true },
      }
      return
    }

    const reader = response.body.getReader()
    const decoder = new SseDecoder()

    const readWithIdleGuard = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new Error('idle-timeout')), idleMs)
        idleTimer.unref?.()
      })
      try {
        return await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(idleTimer)
      }
    }

    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await readWithIdleGuard()
      } catch (error) {
        const isIdle = error instanceof Error && error.message === 'idle-timeout'
        const cancelled = options.signal?.aborted === true
        yield {
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : isIdle
              ? { kind: 'timeout', code: 'idle-timeout', message: `no bytes for ${idleMs}ms`, retryable: true }
              : {
                  kind: 'transport-error',
                  code: 'read-failed',
                  message: error instanceof Error ? error.message : String(error),
                  retryable: true,
                },
        }
        try {
          await reader.cancel()
        } catch {
          /* already closed */
        }
        return
      }
      const results = chunk.done ? decoder.flush() : decoder.push(Buffer.from(chunk.value!))
      for (const item of results) {
        if (item.kind === 'fault') {
          yield {
            type: 'stream-fault',
            fault: {
              kind: 'truncated-stream',
              code: 'sse-dangling-event',
              message: `dangling SSE fragment: ${item.preview}`,
              retryable: false,
            },
          }
          continue
        }
        const payload = item.event.data
        if (payload.trim() === '[DONE]') {
          if (!finished) {
            finished = true
            yield { type: 'finish', reason: 'stop', rawReason: 'stop', toolCalls: finalizeToolCalls(toolAcc) }
          }
          break readLoop
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          yield {
            type: 'stream-fault',
            fault: {
              kind: 'truncated-stream',
              code: 'bad-json-chunk',
              message: `unparseable SSE chunk: ${payload.slice(0, 160)}`,
              retryable: false,
            },
          }
          continue
        }
        for (const event of decodeChunk(parsed, toolAcc)) {
          if (event.type === 'finish') {
            finished = true
            if (event.reason === 'content_filter' || event.reason === 'insufficient_system_resource') {
              // Provider-side termination rides finish_reason on this wire —
              // surface a typed fault (the finish still follows with the
              // accumulated state; DeepSeek documents the resource channel
              // as transient, so it is the retryable one).
              yield {
                type: 'stream-fault',
                fault: {
                  kind: 'provider-termination',
                  code: `finish:${event.rawReason}`,
                  message: `stream terminated by the provider: ${event.rawReason}`,
                  retryable: event.reason === 'insufficient_system_resource',
                },
              }
            }
          }
          if (event.type === 'stream-fault') {
            // The provider stated the failure: no [DONE]-synthesized clean
            // stop after it, and no extra truncation fault on top.
            finished = true
          }
          yield event
        }
      }
      if (chunk.done) break
    }

    if (!finished) {
      yield {
        type: 'stream-fault',
        fault: {
          kind: 'truncated-stream',
          code: 'no-finish',
          message: 'stream ended without finish_reason or [DONE]',
          retryable: true,
        },
      }
    }
  } finally {
    clearTimeout(totalTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
    // RETURN-TO-BASELINE: every generator exit tears the transport down so an
    // abandoned stream never leaks the open SSE socket (the zaiClient law).
    controller.abort()
  }
}

// ── Chunk decoding (one SSE JSON payload → 0..n typed events) ───────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

const KNOWN_FINISH: readonly CompatFinishReason[] = [
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'insufficient_system_resource',
]

/** Decode a usage object across the three documented cached-prefix
 *  spellings (module header) — exported for the usage-truth prover. */
export function decodeCompatUsage(usage: Record<string, unknown>): CompatUsage | undefined {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const prompt = num(usage.prompt_tokens)
  const completion = num(usage.completion_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const details = asRecord(usage.prompt_tokens_details)
  const completionDetails = asRecord(usage.completion_tokens_details)
  const cached =
    num(usage.prompt_cache_hit_tokens) ?? // DeepSeek
    num(usage.cached_tokens) ?? // Moonshot
    num(details?.cached_tokens) // OpenAI-compat standard
  const reasoning = num(completionDetails?.reasoning_tokens)
  const statedCost = num(usage.cost)
  return {
    inputTokens: prompt ?? 0,
    outputTokens: completion ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(statedCost !== undefined ? { statedCostUSD: statedCost } : {}),
  }
}

function decodeChunk(parsed: unknown, toolAcc: Map<number, ToolCallAccumulator>): CompatStreamEvent[] {
  const out: CompatStreamEvent[] = []
  const o = asRecord(parsed)
  // Mid-stream provider-stated failure: OpenAI-compatible servers (vLLM ·
  // LM Studio · proxies) and the Moonshot/DeepSeek fault paths can emit an
  // {"error": …} object as an SSE data payload. It decodes as a typed
  // api-error fault — a provider-stated failure never renders as a clean
  // stop, and it wins over a following [DONE]-synthesized finish.
  const errRecord = asRecord(o?.error)
  if (errRecord !== undefined || typeof o?.error === 'string') {
    const message =
      typeof o?.error === 'string'
        ? o.error
        : String(errRecord?.message ?? JSON.stringify(errRecord).slice(0, 200))
    // OpenRouter's mid-stream envelope carries a NUMERIC code equal to the
    // HTTP status it would have sent (documented) — it rides as the status
    // so the typed classifier reads the class; a string code is the vendor
    // word as on the HTTP path.
    const numericCode = typeof errRecord?.code === 'number' ? errRecord.code : undefined
    const word = vendorErrorWord(errRecord)
    out.push({
      type: 'stream-fault',
      fault: {
        kind: 'api-error',
        code: word !== undefined ? `api-${word}` : numericCode !== undefined ? `http-${numericCode}` : 'mid-stream-error',
        message,
        retryable: false,
        ...(numericCode !== undefined ? { status: numericCode } : {}),
      },
    })
  }
  const choices = Array.isArray(o?.choices) ? o!.choices : []
  const choice = asRecord(choices[0])
  const delta = asRecord(choice?.delta)

  // Reasoning deltas across the spellings the family serves: the
  // `reasoning_content` string (DeepSeek · Moonshot · vLLM · Z.AI-style),
  // the `reasoning` string, and OpenRouter's structured `reasoning_details`
  // array (openrouter.ai/docs/use-cases/reasoning-tokens, fetched
  // 2026-08-23: per-chunk items typed reasoning.text / reasoning.summary /
  // reasoning.encrypted). A chunk that carries a string spelling settles by
  // it alone — the structured items never double-emit the same text.
  const reasoning = delta?.reasoning_content
  const reasoningAlt = delta?.reasoning
  if (typeof reasoning === 'string' && reasoning !== '') {
    out.push({ type: 'reasoning-delta', text: reasoning })
  } else if (typeof reasoningAlt === 'string' && reasoningAlt !== '') {
    out.push({ type: 'reasoning-delta', text: reasoningAlt })
  } else {
    const details = Array.isArray(delta?.reasoning_details) ? delta.reasoning_details : []
    for (const item of details) {
      const rec = asRecord(item)
      const text =
        rec?.type === 'reasoning.text' && typeof rec.text === 'string'
          ? rec.text
          : rec?.type === 'reasoning.summary' && typeof rec.summary === 'string'
            ? rec.summary
            : ''
      if (text !== '') out.push({ type: 'reasoning-delta', text })
    }
  }
  const content = delta?.content
  if (typeof content === 'string' && content !== '') {
    out.push({ type: 'text-delta', text: content })
  }
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta!.tool_calls : []
  for (const raw of toolCalls) {
    const tc = asRecord(raw)
    const fn = asRecord(tc?.function)
    const fragment = typeof fn?.arguments === 'string' ? fn.arguments : ''
    const id = typeof tc?.id === 'string' && tc.id !== '' ? tc.id : undefined
    const name = typeof fn?.name === 'string' && fn.name !== '' ? fn.name : undefined
    const index = toolCallSlot(toolAcc, typeof tc?.index === 'number' ? tc.index : undefined, id, name)
    const existing = toolAcc.get(index) ?? { index, argumentsRaw: '' }
    if (id && !existing.id) existing.id = id
    if (name && !existing.name) existing.name = name
    existing.argumentsRaw += fragment
    toolAcc.set(index, existing)
    out.push({
      type: 'tool-call-fragment',
      index,
      ...(id !== undefined ? { id } : {}),
      ...(name !== undefined ? { name } : {}),
      argumentsFragment: fragment,
    })
  }

  const usageRecord = asRecord(o?.usage)
  if (usageRecord) {
    const usage = decodeCompatUsage(usageRecord)
    if (usage) out.push({ type: 'usage', usage })
  }

  const finishRaw = choice?.finish_reason
  if (finishRaw === 'error') {
    // OpenRouter's mid-stream failure chunk (documented): the top-level
    // error object above IS the settlement, and finish_reason 'error' only
    // terminates the stream — it never settles a finish, or a pre-content
    // failure would read as a continuable partial-content fault. A bare
    // 'error' finish with no error object is the provider-termination class.
    if (errRecord === undefined && typeof o?.error !== 'string') {
      out.push({
        type: 'stream-fault',
        fault: {
          kind: 'provider-termination',
          code: 'finish:error',
          message: 'stream terminated by the provider: error',
          retryable: false,
        },
      })
    }
    return out
  }
  if (typeof finishRaw === 'string' && finishRaw !== '') {
    const known = KNOWN_FINISH.includes(finishRaw as CompatFinishReason)
    out.push({
      type: 'finish',
      reason: known ? (finishRaw as CompatFinishReason) : 'other',
      rawReason: finishRaw,
      toolCalls: finalizeToolCalls(toolAcc),
    })
  }
  return out
}
