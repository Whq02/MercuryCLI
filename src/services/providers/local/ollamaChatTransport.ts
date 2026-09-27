import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
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
import {
  describeTransportFailure,
  mapCompatHttpFailure,
  type CompatChatRequest,
  type CompatCompletedToolCall,
  type CompatMessage,
  type CompatStreamEvent,
  type CompatStreamOptions,
} from '../openaicompat/compatChatClient.js'

const TOTAL_TIMEOUT_MS = 50 * 60_000

export interface OllamaChatKnobs {
  numCtx?: number
  numBatch?: number
  think?: boolean | string
  keepAlive?: string | number
}

type OllamaMessage = {
  role: string
  content: string
  images?: string[]
  tool_calls?: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }>
  tool_call_id?: string
  tool_name?: string
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function argumentsObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw.trim() === '' ? '{}' : raw)
    return rec(parsed) ?? {}
  } catch {
    return {}
  }
}

function dataUrlBase64(url: string): string | undefined {
  const m = /^data:[^;]+;base64,(.+)$/s.exec(url)
  return m?.[1]
}

export function ollamaMessagesOf(messages: readonly CompatMessage[]): OllamaMessage[] {
  const namesByCallId = new Map<string, string>()
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) namesByCallId.set(call.id, call.function.name)
  }
  const out: OllamaMessage[] = []
  for (const m of messages) {
    let content = ''
    const images: string[] = []
    if (typeof m.content === 'string') content = m.content
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') content += part.text
        else if (part.type === 'image_url') {
          const b64 = dataUrlBase64(part.image_url.url)
          if (b64 !== undefined) images.push(b64)
          else content += `[image ${part.image_url.url}]`
        }
      }
    }
    const row: OllamaMessage = { role: m.role, content }
    if (images.length > 0) row.images = images
    if (m.tool_calls !== undefined && m.tool_calls.length > 0) {
      row.tool_calls = m.tool_calls.map(call => ({ id: call.id, function: { name: call.function.name, arguments: argumentsObject(call.function.arguments) } }))
    }
    if (m.role === 'tool' && m.tool_call_id !== undefined) {
      row.tool_call_id = m.tool_call_id
      const name = namesByCallId.get(m.tool_call_id)
      if (name !== undefined) row.tool_name = name
    }
    out.push(row)
  }
  return out
}

export function ollamaChatBody(request: CompatChatRequest, knobs: OllamaChatKnobs): Record<string, unknown> {
  const extra = request.extra ?? {}
  const options: Record<string, unknown> = {}
  if (knobs.numCtx !== undefined) options.num_ctx = knobs.numCtx
  if (knobs.numBatch !== undefined) options.num_batch = knobs.numBatch
  if (typeof extra.max_tokens === 'number') options.num_predict = extra.max_tokens
  return {
    model: request.model,
    messages: ollamaMessagesOf(request.messages),
    ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools } : {}),
    stream: true,
    truncate: false,
    ...(knobs.think !== undefined ? { think: knobs.think } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(knobs.keepAlive !== undefined ? { keep_alive: knobs.keepAlive } : {}),
  }
}

export function ollamaChatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/v1\/?$/, '')}/api/chat`
}

class LineSplitter {
  private buffer = ''
  push(chunk: Buffer): string[] {
    this.buffer += chunk.toString('utf8')
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.map(line => line.trim()).filter(line => line !== '')
  }
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest === '' ? [] : [rest]
  }
}

type RowOutcome = { events: CompatStreamEvent[]; done: boolean }

function decodeRow(parsed: unknown, calls: CompatCompletedToolCall[], seen: { model?: string }): RowOutcome {
  const row = rec(parsed)
  if (row === undefined) return { events: [], done: false }
  const events: CompatStreamEvent[] = []
  if (typeof row.error === 'string' && row.error !== '') {
    events.push({ type: 'stream-fault', fault: { kind: 'api-error', code: 'api-error', message: row.error, retryable: false, status: 400 } })
    return { events, done: true }
  }
  const model = typeof row.model === 'string' ? row.model : undefined
  if (model !== undefined && model !== seen.model) {
    seen.model = model
    events.push({ type: 'served-model', model })
  }
  const message = rec(row.message)
  if (message !== undefined) {
    if (typeof message.thinking === 'string' && message.thinking !== '') events.push({ type: 'reasoning-delta', text: message.thinking })
    if (typeof message.content === 'string' && message.content !== '') events.push({ type: 'text-delta', text: message.content })
    if (Array.isArray(message.tool_calls)) {
      for (const raw of message.tool_calls) {
        const call = rec(raw)
        const fn = rec(call?.function)
        const name = typeof fn?.name === 'string' ? fn.name : ''
        const args = rec(fn?.arguments) ?? {}
        const index = typeof fn?.index === 'number' ? fn.index : calls.length
        const id = typeof call?.id === 'string' && call.id !== '' ? call.id : `call_${index}_${calls.length}`
        const argumentsRaw = JSON.stringify(args)
        const malformed = name === ''
        calls.push({ index, id, name, argumentsRaw, ...(malformed ? {} : { arguments: args }), malformed })
        events.push({ type: 'tool-call-fragment', index, id, name, argumentsFragment: argumentsRaw })
      }
    }
  }
  if (row.done === true) {
    const promptTokens = typeof row.prompt_eval_count === 'number' ? row.prompt_eval_count : 0
    const outputTokens = typeof row.eval_count === 'number' ? row.eval_count : 0
    const cached = typeof row.prompt_eval_cached_count === 'number' ? row.prompt_eval_cached_count : undefined
    events.push({ type: 'usage', usage: { inputTokens: promptTokens, outputTokens, ...(cached !== undefined ? { cachedInputTokens: cached } : {}) } })
    const rawReason = typeof row.done_reason === 'string' && row.done_reason !== '' ? row.done_reason : 'stop'
    const reason = calls.length > 0 ? 'tool_calls' : rawReason === 'length' ? 'length' : rawReason === 'stop' ? 'stop' : 'other'
    events.push({ type: 'finish', reason, rawReason, toolCalls: [...calls] })
    return { events, done: true }
  }
  return { events, done: false }
}

export async function* streamOllamaChat(options: CompatStreamOptions, knobs: OllamaChatKnobs): AsyncGenerator<CompatStreamEvent> {
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()
  let idleWatchdog: StreamIdleWatchdog | null = null
  const calls: CompatCompletedToolCall[] = []
  const seen: { model?: string } = {}
  let finished = false
  try {
    let response: Response
    const firstByteBudget = firstByteBudgetMs({ cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0, idleMs })
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
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/x-ndjson',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          'user-agent': getUserAgent(),
          ...(options.extraHeaders ?? {}),
        },
        body: JSON.stringify(ollamaChatBody(options.request, knobs)),
        signal: controller.signal,
        ...(proxyOptions as Record<string, unknown>),
      } as RequestInit)
    } catch (error) {
      clearTimeout(firstByteTimer)
      const cancelled = options.signal?.aborted === true
      if (!cancelled && firstByteFired) {
        yield { type: 'stream-fault', fault: { kind: 'timeout', code: 'first-byte-timeout', message: firstByteTimeoutLine(wait), retryable: true } }
        return
      }
      const outage = cancelled ? null : outageCauseOfFetchFailure(error)
      yield {
        type: 'stream-fault',
        fault: cancelled
          ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled before response', retryable: false }
          : { kind: 'transport-error', code: 'fetch-failed', message: describeTransportFailure(error, options.url), retryable: true, ...(outage !== null ? { outage } : {}) },
      }
      return
    }
    try {
      options.onResponseHeaders?.(response.headers, response.status)
    } catch {
      void 0
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
      yield { type: 'stream-fault', fault: mapCompatHttpFailure(response.status, body, response.headers) }
      return
    }
    if (!response.body) {
      yield { type: 'stream-fault', fault: { kind: 'transport-error', code: 'no-body', message: 'response had no body', retryable: true } }
      return
    }
    const reader = response.body.getReader()
    const splitter = new LineSplitter()
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
              : { kind: 'transport-error', code: 'read-failed', message: error instanceof Error ? error.message : String(error), retryable: true },
        }
        void reader.cancel().catch(() => {})
        return
      }
      const lines = chunk.done ? splitter.flush() : splitter.push(Buffer.from(chunk.value!))
      if (lines.length > 0) relay.noteEvent()
      else relay.noteChunk()
      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'bad-json-chunk', message: `unparseable NDJSON row: ${line.slice(0, 160)}`, retryable: false } }
          continue
        }
        const outcome = decodeRow(parsed, calls, seen)
        for (const event of outcome.events) yield event
        if (outcome.done) {
          finished = true
          break readLoop
        }
      }
      if (chunk.done) break
    }
    if (!finished) {
      yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'no-finish', message: 'stream ended without a done row', retryable: true } }
    }
  } finally {
    clearTimeout(totalTimer)
    idleWatchdog?.stop()
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}
