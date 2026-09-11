import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { SseDecoder } from '../sseDecoder.js'
import { retryAfterHeaderMs } from '../../api/retryAfter.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  streamIdleTimeoutMs,
  StreamIdleTimeoutError,
  streamIdleFaultWords,
  type RequestWaitV1,
  type StreamIdleWatchdog,
} from '../streamIdleBudget.js'

export const ZAI_CHAT_COMPLETIONS_URL = 'https://api.z.ai/api/paas/v4/chat/completions'
const ZAI_API_BASE_URL = 'https://api.z.ai/api/paas/v4'
export const ZAI_CODING_API_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
export type ZaiApiPlan = 'general' | 'coding'
export function zaiApiBase(env: NodeJS.ProcessEnv = process.env, plan: ZaiApiPlan = 'general'): string {
  const production = plan === 'coding' ? ZAI_CODING_API_BASE_URL : ZAI_API_BASE_URL
  return (env['MERCURY_ZAI_API_BASE']?.trim() || production).replace(/\/+$/, '')
}
export function zaiChatCompletionsUrl(env: NodeJS.ProcessEnv = process.env, plan: ZaiApiPlan = 'general'): string {
  return `${zaiApiBase(env, plan)}/chat/completions`
}
const TOTAL_TIMEOUT_MS = 50 * 60_000


export type ZaiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ZaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ZaiContentPart[]
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
  tool_choice?: 'auto'
  max_tokens?: number
  temperature?: number
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: string
  request_id?: string
}


export type ZaiFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'sensitive'
  | 'model_context_window_exceeded'
  | 'network_error'
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
  argumentsRaw: string
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
      rawReason: string
      toolCalls: ZaiCompletedToolCall[]
    }
  | { type: 'stream-fault'; fault: ZaiFault }

export interface ZaiFault {
  kind:
    | 'http-error'
    | 'api-error'
    | 'mid-stream-failure'
    | 'truncated-stream'
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
  code: string
  message: string
  retryable: boolean
  status?: number
  retryAfterMs?: number
}


const RETRYABLE_ZAI_CODES = new Set([1302, 1305, 1113, 1234, 1230])

export function mapZaiHttpFailure(status: number, body: unknown, headers?: { get(name: string): string | null }): ZaiFault {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  const err = typeof o?.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : undefined
  const codeNum = Number(err?.code ?? o?.code)
  const message = String(err?.message ?? o?.message ?? `HTTP ${status}`)
  const retryAfterMs = retryAfterHeaderMs(headers?.get('retry-after') ?? undefined)
  const asked = retryAfterMs !== undefined ? { retryAfterMs } : {}
  if (Number.isFinite(codeNum) && codeNum > 0) {
    return {
      kind: 'api-error',
      code: `zai-${codeNum}`,
      message,
      retryable: RETRYABLE_ZAI_CODES.has(codeNum) || status === 429 || status >= 500,
      status,
      ...asked,
    }
  }
  return {
    kind: 'http-error',
    code: `http-${status}`,
    message,
    retryable: status === 429 || status >= 500,
    status,
    ...asked,
  }
}


export interface ZaiStreamOptions {
  apiKey: string
  request: ZaiChatRequest
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
  onStreamActivity?: (atMs: number) => void
  firstByte?: {
    cold: boolean
    promptTokens: number
    model: string
    attempt?: number
    onWait?: (wait: RequestWaitV1 | null) => void
  }
  baseUrl?: string
}

interface ToolCallAccumulator {
  index: number
  id?: string
  name?: string
  argumentsRaw: string
}

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

export async function* streamZaiChat(options: ZaiStreamOptions): AsyncGenerator<ZaiStreamEvent> {
  const { apiKey, request } = options
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const url = options.baseUrl ?? ZAI_CHAT_COMPLETIONS_URL
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()
  let idleWatchdog: StreamIdleWatchdog | null = null

  const toolAcc = new Map<number, ToolCallAccumulator>()
  let usageSeen: ZaiUsage | undefined
  let finished = false

  try {
    let response: Response
    const firstByteBudget = firstByteBudgetMs({
      cold: options.firstByte?.cold === true,
      promptTokens: options.firstByte?.promptTokens ?? 0,
      idleMs: idleMs,
    })
    const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
      kind: 'first-byte',
      cold: options.firstByte?.cold === true,
      promptTokens: options.firstByte?.promptTokens ?? 0,
      model: options.firstByte?.model ?? 'the model',
      budgetMs: firstByteBudget,
      sinceMs: Date.now(),
      attempt: options.firstByte?.attempt ?? 1,
    }
    options.firstByte?.onWait?.(wait)
    let firstByteFired = false
    const firstByteTimer = setTimeout(() => {
      firstByteFired = true
      controller.abort()
    }, firstByteBudget)
    firstByteTimer.unref?.()
    try {
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
      clearTimeout(firstByteTimer)
      const cancelled = options.signal?.aborted === true
      if (!cancelled && firstByteFired) {
        yield {
          type: 'stream-fault',
          fault: { kind: 'timeout', code: 'first-byte-timeout', message: firstByteTimeoutLine(wait), retryable: true },
        }
        return
      }
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

    clearTimeout(firstByteTimer)
    options.firstByte?.onWait?.(null)

    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      yield { type: 'stream-fault', fault: mapZaiHttpFailure(response.status, body, response.headers) }
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
    const watchdog = createStreamIdleWatchdog({ timeoutMs: idleMs })
    idleWatchdog = watchdog
    const relay = createStreamActivityRelay(atMs => options.onStreamActivity?.(atMs))

    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await watchdog.guard(reader.read())
        watchdog.noteActivity()
      } catch (error) {
        const isIdle = error instanceof StreamIdleTimeoutError
        const cancelled = options.signal?.aborted === true
        yield {
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : isIdle
              ? { kind: 'timeout', code: 'idle-timeout', message: streamIdleFaultWords(idleMs), retryable: true }
              : {
                  kind: 'transport-error',
                  code: 'read-failed',
                  message: error instanceof Error ? error.message : String(error),
                  retryable: true,
                },
        }
        void reader.cancel().catch(() => {})
        return
      }
      const results = chunk.done
        ? decoder.flush()
        : decoder.push(Buffer.from(chunk.value!))
      if (results.some(item => item.kind === 'event')) relay.noteEvent()
      else relay.noteChunk()
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
          if (event.type === 'usage') usageSeen = event.usage
          if (event.type === 'finish') {
            finished = true
            const failureReasons: ZaiFinishReason[] = [
              'sensitive',
              'model_context_window_exceeded',
              'network_error',
            ]
            if (failureReasons.includes(event.reason)) {
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
    idleWatchdog?.stop()
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }

  void usageSeen
}


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
