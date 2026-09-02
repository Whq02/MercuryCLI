// ============================================================================
//  providers/zai/zaiClient — the native Z.AI GLM chat-completions streaming
//  client. NATIVE means the documented wire at
//  https://api.z.ai/api/paas/v4/chat/completions — never the Anthropic-compat
//  endpoint (https://api.z.ai/api/anthropic is RECORDED TO AVOID: it would
//  boot a second Mercury-shaped loop on relabeled models).
//
//  Grounding (recorded provider research, fetched
// request params (tools · tool_choice:"auto" only · stream ·
//  tool_stream · thinking · reasoning_effort on glm-5.2), the SSE chunk shape
//  (choices[0].delta{content, reasoning_content, tool_calls[{index,id,type,
//  function{name,arguments-fragment}}]}, finish_reason enum, usage in the
//  FINAL chunk, `data: [DONE]` sentinel), the documented SSE
//  abnormal-termination rule (mid-stream failures arrive as finish_reason
//  values — sensitive | model_context_window_exceeded | network_error — NOT
//  error frames), and the numeric error table (1000-1005 auth · 1113 balance
//  · 1211 unknown model · 1301 sensitive · 1302/1305 rate/overload …).
//
//  Laws:
//    - rides the existing HTTP owners: getProxyFetchOptions() (never the
//      forAnthropicAPI flag) + getUserAgent(); its own bounded idle watchdog
//      + AbortSignal cancellation; NEVER the Anthropic OAuth/keychain
//      machinery;
//    - typed events out, faults as data: HTTP errors map through the
//      documented code table; mid-stream aborts surface as typed failures;
//      the [DONE] sentinel closes the stream; a stream that ends without
//      finish_reason or [DONE] is a typed truncation fault;
//    - tool-call deltas are index-keyed fragments accumulated EXACTLY ONCE
//      into complete calls (id/name on first sight, arguments concatenated);
//      completion is checked at finish — a call whose accumulated arguments
//      fail to parse as JSON is a typed malformed-tool-call, never a silent
//      half-call;
//    - the key comes from the caller (resolution order lives with discovery/
//      settings) and never enters logs or error text.
// ============================================================================
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { SseDecoder } from '../sseDecoder.js'
import { compatStreamIdleTimeoutMs } from '../streamIdleBudget.js'

export const ZAI_CHAT_COMPLETIONS_URL = 'https://api.z.ai/api/paas/v4/chat/completions'
const ZAI_API_BASE_URL = 'https://api.z.ai/api/paas/v4'
/** The GLM Coding Plan's OpenAI-compatible base (docs.z.ai/devpack/tool/
 *  others, fetched): a Coding Plan key is valid here, not on the
 *  general base — the key's stored plan picks the base. */
export const ZAI_CODING_API_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
export type ZaiApiPlan = 'general' | 'coding'
/** The native API base for a plan; MERCURY_ZAI_API_BASE pins it for
 *  loopback fixtures whatever the plan (every provider family is fixture-
 *  pinnable by env, so a prover never needs to patch global fetch and
 *  nothing can reach a live host). */
export function zaiApiBase(env: NodeJS.ProcessEnv = process.env, plan: ZaiApiPlan = 'general'): string {
  const production = plan === 'coding' ? ZAI_CODING_API_BASE_URL : ZAI_API_BASE_URL
  return (env['MERCURY_ZAI_API_BASE']?.trim() || production).replace(/\/+$/, '')
}
export function zaiChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env, plan: ZaiApiPlan = 'general'): string {
  return `${zaiApiBase(env, plan)}/chat/completions`
}
// The byte-idle guard's budget: the one stream idle owner's default
// (providers/streamIdleBudget), so the status row and this guard agree.
const IDLE_TIMEOUT_MS = compatStreamIdleTimeoutMs()
/** Z.AI's own tooling sets ~50-minute client timeouts for long thinking turns
 *  (measured); this is the hard whole-request ceiling. */
const TOTAL_TIMEOUT_MS = 50 * 60_000

// ── Request shapes (the documented native wire) ─────────────────────────────

export interface ZaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  /** Historical assistant reasoning returned to the provider — sent only
   *  on lanes whose docs require/accept it (Kimi Preserved Thinking; the
   *  documented multi-turn shape puts it beside content on historical
   *  assistant messages). */
  reasoning_content?: string
  tool_calls?: ZaiToolCall[]
  tool_call_id?: string
}

export interface ZaiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ZaiTool {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

export interface ZaiChatRequest {
  model: string
  messages: ZaiMessage[]
  tools?: ZaiTool[]
  /** The only documented value. */
  tool_choice?: 'auto'
  max_tokens?: number
  temperature?: number
  thinking?: { type: 'enabled' | 'disabled' }
  /** glm-5.2 only (documented): max|xhigh|high|medium|low|minimal|none. */
  reasoning_effort?: string
  request_id?: string
}

// ── Typed stream events ─────────────────────────────────────────────────────

export type ZaiFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'sensitive'
  | 'model_context_window_exceeded'
  | 'network_error'
  /** A finish word outside the documented table: settles as end_turn with
   *  the raw word preserved — a new vendor word is never a fake truncation. */
  | 'other'

export interface ZaiUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}

export interface ZaiCompletedToolCall {
  index: number
  id: string
  name: string
  /** The raw accumulated arguments string (always preserved). */
  argumentsRaw: string
  /** Parsed arguments when they form valid JSON. */
  arguments?: unknown
  malformed: boolean
}

export type ZaiStreamEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-fragment'; index: number; id?: string; name?: string; argumentsFragment: string }
  | { type: 'usage'; usage: ZaiUsage }
  | {
      type: 'finish'
      reason: ZaiFinishReason
      /** The provider's raw finish_reason string (reason 'other' keeps the
       *  vendor word visible instead of erasing it). */
      rawReason: string
      toolCalls: ZaiCompletedToolCall[]
    }
  | { type: 'stream-fault'; fault: ZaiFault }

export interface ZaiFault {
  kind:
    | 'http-error'
    | 'api-error'
    | 'mid-stream-failure' // the documented finish_reason failure channel
    | 'truncated-stream'
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
  /** Stable, code-first detail: e.g. 'http-401', 'zai-1211:Unknown Model',
   *  'finish:network_error', 'idle-timeout'. Never carries the key. */
  code: string
  message: string
  retryable: boolean
  /** The HTTP status when the fault came from a response. */
  status?: number
}

// ── Error mapping (the documented table) ────────────────────────────────────

const RETRYABLE_ZAI_CODES = new Set([1302, 1305, 1113, 1234, 1230])

export function mapZaiHttpFailure(status: number, body: unknown): ZaiFault {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  const err = typeof o?.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : undefined
  const codeNum = Number(err?.code ?? o?.code)
  const message = String(err?.message ?? o?.message ?? `HTTP ${status}`)
  if (Number.isFinite(codeNum) && codeNum > 0) {
    return {
      kind: 'api-error',
      code: `zai-${codeNum}`,
      message,
      retryable: RETRYABLE_ZAI_CODES.has(codeNum) || status === 429 || status >= 500,
      status,
    }
  }
  return {
    kind: 'http-error',
    code: `http-${status}`,
    message,
    retryable: status === 429 || status >= 500,
    status,
  }
}

// ── The streaming call ──────────────────────────────────────────────────────

export interface ZaiStreamOptions {
  apiKey: string
  request: ZaiChatRequest
  signal?: AbortSignal
  /** Proof seam — fixtures inject a fake fetch; production uses global fetch
   *  with the proxy options. */
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
  baseUrl?: string
}

interface ToolCallAccumulator {
  index: number
  id?: string
  name?: string
  argumentsRaw: string
}

/** The slot a tool_call delta accumulates into (the compat client's law,
 *  held here too): the wire's `index` wins; without one, an id joins its
 *  own slot or opens a new one, a name-only delta continues the latest
 *  slot when the name agrees and opens a new one otherwise, and a bare
 *  arguments fragment continues the latest slot. */
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

function finalizeToolCalls(acc: Map<number, ToolCallAccumulator>): ZaiCompletedToolCall[] {
  const out: ZaiCompletedToolCall[] = []
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

/** Stream one chat completion as typed events. The generator NEVER throws for
 *  provider/transport trouble — faults are events; it throws only for
 *  programmer errors (e.g. a missing key is the caller's refusal to make). */
export async function* streamZaiChat(options: ZaiStreamOptions): AsyncGenerator<ZaiStreamEvent> {
  const { apiKey, request } = options
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const url = options.baseUrl ?? ZAI_CHAT_COMPLETIONS_URL
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()

  const toolAcc = new Map<number, ToolCallAccumulator>()
  let usageSeen: ZaiUsage | undefined
  let finished = false

  try {
    let response: Response
    try {
      // pair the fetch with the dispatcher's undici (getApiFetch) —
      // Node's internal fetch rejects the bundled dispatcher cross-version.
      const fetchImpl = options.fetchImpl ?? getApiFetch()
      const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
          'user-agent': getUserAgent(),
        },
        body: JSON.stringify({ ...request, stream: true }),
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
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
      }
      return
    }

    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      yield { type: 'stream-fault', fault: mapZaiHttpFailure(response.status, body) }
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
      const results = chunk.done
        ? decoder.flush()
        : decoder.push(Buffer.from(chunk.value!))
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
            // [DONE] without a finish_reason chunk: settle what we have.
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
          if (event.type === 'usage') usageSeen = event.usage
          if (event.type === 'finish') {
            finished = true
            const failureReasons: ZaiFinishReason[] = [
              'sensitive',
              'model_context_window_exceeded',
              'network_error',
            ]
            if (failureReasons.includes(event.reason)) {
              // The documented SSE abnormal-termination rule: failures ride
              // finish_reason, not error frames — surface as a typed fault
              // (the finish event still follows for the accumulated state).
              yield {
                type: 'stream-fault',
                fault: {
                  kind: 'mid-stream-failure',
                  code: `finish:${event.reason}`,
                  message: `stream terminated by the provider: ${event.reason}`,
                  retryable: event.reason === 'network_error',
                },
              }
            }
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
    // RETURN-TO-BASELINE (TEMPER T2): every generator exit — completion,
    // fault, or an abandoning consumer's return() cascading down the
    // async-generator chain — tears the transport down. A consumed response
    // is unaffected; an abandoned one must not leak the open SSE socket
    // until the server hangs up. (The Anthropic path's cleanupStream is the
    // same law at its own seam.)
    controller.abort()
  }

  void usageSeen // (usage is delivered as its own event; kept for symmetry)
}

// ── Chunk decoding (one SSE JSON payload → 0..n typed events) ───────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

const FINISH_REASONS: readonly ZaiFinishReason[] = [
  'stop',
  'tool_calls',
  'length',
  'sensitive',
  'model_context_window_exceeded',
  'network_error',
]

function decodeChunk(parsed: unknown, toolAcc: Map<number, ToolCallAccumulator>): ZaiStreamEvent[] {
  const out: ZaiStreamEvent[] = []
  const o = asRecord(parsed)
  const choices = Array.isArray(o?.choices) ? o!.choices : []
  const choice = asRecord(choices[0])
  const delta = asRecord(choice?.delta)

  const reasoning = delta?.reasoning_content
  if (typeof reasoning === 'string' && reasoning !== '') {
    out.push({ type: 'reasoning-delta', text: reasoning })
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

  const usage = asRecord(o?.usage)
  if (usage && (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number')) {
    const details = asRecord(usage.prompt_tokens_details)
    out.push({
      type: 'usage',
      usage: {
        inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
        ...(typeof details?.cached_tokens === 'number' ? { cachedInputTokens: details.cached_tokens } : {}),
      },
    })
  }

  // A finish word outside the documented table settles as 'other' with the
  // raw word preserved (the compat client's law): the turn ends honestly
  // instead of waiting for a [DONE] that a proxy may never send and then
  // reporting a truncation that did not happen.
  const finishRaw = choice?.finish_reason
  if (typeof finishRaw === 'string' && finishRaw !== '') {
    const known = FINISH_REASONS.includes(finishRaw as ZaiFinishReason)
    out.push({
      type: 'finish',
      reason: known ? (finishRaw as ZaiFinishReason) : 'other',
      rawReason: finishRaw,
      toolCalls: finalizeToolCalls(toolAcc),
    })
  }
  return out
}
