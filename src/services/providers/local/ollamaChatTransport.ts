import { Agent } from 'undici'
import type { AssistantMessage } from '../../../types/message.js'
import { requestTurnOf } from '../../../rows/request.js'
import { logForDebugging } from '../../../utils/debug.js'
import { buildApiAgentOptions, getApiDispatcher, getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  REAL_STREAM_TIMERS,
  streamIdleTimeoutMs,
  StreamIdleTimeoutError,
  streamIdleFaultWords,
  type RequestWaitV1,
  type StreamIdleWatchdog,
} from '../streamIdleBudget.js'
import {
  LOCAL_CAP_CODE,
  LOCAL_DEAD_SERVER_CODE,
  LOCAL_LOADING_POLL_MS,
  LOCAL_REQUEST_CAP_MS,
  localCapLine,
  localDeadServerLine,
  localPromiseExtensionMs,
  startLocalLivenessLoop,
  type LocalLivenessLoop,
} from '../localLiveness.js'
import {
  describeTransportFailure,
  mapCompatHttpFailure,
  startLocalSilenceWatch,
  type CompatChatRequest,
  type CompatCompletedToolCall,
  type CompatStreamEvent,
  type CompatStreamOptions,
  type CompatWireMessage,
} from '../openaicompat/compatChatClient.js'

const TOTAL_TIMEOUT_MS = 50 * 60_000
export const OLLAMA_WIRE_DUMP_CHARS = 2_000

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

export type OllamaFinishEvent = Extract<CompatStreamEvent, { type: 'finish' }> & { reasoningOnly?: true }

export interface OllamaStreamShape {
  rows: number
  thinkingChars: number
  contentChars: number
  replyChars: number
  toolCalls: number
  doneReason: string | null
  reasoningOnly: boolean
  ended: string
}

export function newOllamaStreamShape(): OllamaStreamShape {
  return { rows: 0, thinkingChars: 0, contentChars: 0, replyChars: 0, toolCalls: 0, doneReason: null, reasoningOnly: false, ended: 'open' }
}

export function ollamaWireDumpLine(model: string, shape: OllamaStreamShape, head: string, totalChars: number): string {
  const kept = head.replace(/\r?\n/g, '↵')
  return `[compat:local] /api/chat stream from ${model}: ${shape.rows} rows · thinking ${shape.thinkingChars} chars · content ${shape.contentChars} chars · tool calls ${shape.toolCalls} · done_reason ${shape.doneReason ?? 'none'} · ${shape.reasoningOnly ? 'reasoning-only' : 'reply'} · ended ${shape.ended} · head (first ${kept.length} of ${totalChars} chars): ${kept}`
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function unrefTimer(handle: unknown): void {
  ;(handle as { unref?: () => void } | null | undefined)?.unref?.()
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

export function ollamaMessagesOf(messages: readonly CompatWireMessage[]): OllamaMessage[] {
  const namesByCallId = new Map<string, string>()
  for (const m of messages) {
    if (!('content' in m)) continue
    for (const call of m.tool_calls ?? []) namesByCallId.set(call.id, call.function.name)
  }
  const out: OllamaMessage[] = []
  for (const m of messages) {
    if (!('content' in m)) continue
    let content = ''
    const images: string[] = []
    const turn = requestTurnOf(m.role === 'assistant' ? 'assistant' : 'user', m.content)
    if (turn.stringContent !== undefined) content = turn.stringContent
    else {
      for (const item of turn.items) {
        if (item.type === 'text') content += item.text
        else if ((item.value as { type: string }).type === 'image_url') {
          const url = (item.value as unknown as { image_url: { url: string } }).image_url.url
          const b64 = dataUrlBase64(url)
          if (b64 !== undefined) images.push(b64)
          else content += `[image ${url}]`
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

export function localApiAgentOptions(): ReturnType<typeof buildApiAgentOptions> {
  return { ...buildApiAgentOptions(), headersTimeout: LOCAL_REQUEST_CAP_MS, bodyTimeout: LOCAL_REQUEST_CAP_MS }
}

let localDispatcher: { api: unknown; agent: unknown } | null = null

export function withLocalDispatcher(fetchOptions: Record<string, unknown>, api: unknown, build: () => unknown): Record<string, unknown> {
  if (!('dispatcher' in fetchOptions) || fetchOptions.dispatcher !== api) return fetchOptions
  if (localDispatcher === null || localDispatcher.api !== api) localDispatcher = { api, agent: build() }
  return { ...fetchOptions, dispatcher: localDispatcher.agent }
}

export function localFetchOptions(): Record<string, unknown> {
  const options = getProxyFetchOptions()
  if (!('dispatcher' in options)) return options
  return withLocalDispatcher(options, getApiDispatcher(), () => new Agent(localApiAgentOptions() as never))
}

class LineSplitter {
  private buffer = ''
  push(text: string): string[] {
    this.buffer += text
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

function decodeRow(parsed: unknown, calls: CompatCompletedToolCall[], seen: { model?: string }, shape: OllamaStreamShape): RowOutcome {
  const row = rec(parsed)
  if (row === undefined) return { events: [], done: false }
  shape.rows += 1
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
    if (typeof message.thinking === 'string' && message.thinking !== '') {
      shape.thinkingChars += message.thinking.length
      events.push({ type: 'reasoning-delta', text: message.thinking })
    }
    if (typeof message.content === 'string' && message.content !== '') {
      shape.contentChars += message.content.length
      shape.replyChars += message.content.trim().length
      events.push({ type: 'text-delta', text: message.content })
    }
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
        shape.toolCalls += 1
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
    shape.doneReason = rawReason
    shape.reasoningOnly = shape.thinkingChars > 0 && shape.replyChars === 0 && calls.length === 0
    const finish: OllamaFinishEvent = { type: 'finish', reason, rawReason, toolCalls: [...calls], ...(shape.reasoningOnly ? { reasoningOnly: true } : {}) }
    events.push(finish)
    return { events, done: true }
  }
  return { events, done: false }
}

function ingestMsOfDoneRow(parsed: unknown): number | null {
  const row = rec(parsed)
  const ns = row?.prompt_eval_duration
  if (typeof ns !== 'number' || !Number.isFinite(ns) || ns <= 0) return null
  return Math.max(1, Math.round(ns / 1_000_000))
}

export function ollamaChatTransport(options: CompatStreamOptions, knobs: OllamaChatKnobs): { events: AsyncGenerator<CompatStreamEvent>; settle(messages: readonly AssistantMessage[]): void } {
  const shape = newOllamaStreamShape()
  return {
    events: streamOllamaChat(options, knobs, shape),
    settle(messages) {
      const last = messages.at(-1)
      if (last !== undefined && shape.reasoningOnly) last.reasoningOnly = true
    },
  }
}

export async function* streamOllamaChat(options: CompatStreamOptions, knobs: OllamaChatKnobs, shape: OllamaStreamShape = newOllamaStreamShape()): AsyncGenerator<CompatStreamEvent> {
  const timers = options.timers ?? REAL_STREAM_TIMERS
  const local = options.local
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const requestStartedAt = timers.now()
  const cut: { dead: { unansweredMs: number } | null; cap: boolean } = { dead: null, cap: false }
  const totalTimer = timers.setTimeout(() => {
    cut.cap = true
    controller.abort()
  }, local !== undefined ? local.capMs : TOTAL_TIMEOUT_MS)
  unrefTimer(totalTimer)
  let idleWatchdog: StreamIdleWatchdog | null = null
  let silenceWatch: ReturnType<typeof startLocalSilenceWatch> | null = null
  let ingestMs: number | null = null
  const calls: CompatCompletedToolCall[] = []
  const seen: { model?: string } = {}
  let head = ''
  let totalChars = 0
  let finished = false
  const fault = (f: Extract<CompatStreamEvent, { type: 'stream-fault' }>['fault']): CompatStreamEvent => {
    shape.ended = f.kind === 'cancelled' ? 'cancelled' : `fault ${f.code}`
    return { type: 'stream-fault', fault: f }
  }
  try {
    let response: Response
    const firstByteBudget =
      local !== undefined
        ? local.promiseMs
        : firstByteBudgetMs({ cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0, idleMs })
    const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
      kind: 'first-byte',
      cold: options.firstByte?.cold === true,
      promptTokens: options.firstByte?.promptTokens ?? 0,
      model: options.firstByte?.model ?? local?.wireModel ?? 'the model',
      budgetMs: firstByteBudget,
      sinceMs: timers.now(),
      attempt: options.firstByte?.attempt ?? 1,
      ...(local !== undefined ? { promise: true } : {}),
    }
    const publish = (next: RequestWaitV1 | null): void => options.firstByte?.onWait?.(next)
    publish(wait)
    let firstByteFired = false
    let firstByteTimer: unknown = null
    let headersLanded = false
    let ingestStartedAt = timers.now()
    let promiseLoop: LocalLivenessLoop | null = null
    let loadingHandle: unknown = null
    const stopIngestWatch = (): void => {
      promiseLoop?.stop()
      promiseLoop = null
      if (loadingHandle !== null) {
        timers.clearTimeout(loadingHandle)
        loadingHandle = null
      }
    }
    if (local === undefined) {
      firstByteTimer = timers.setTimeout(() => {
        firstByteFired = true
        controller.abort()
      }, firstByteBudget)
      unrefTimer(firstByteTimer)
    } else {
      const law = local
      let promisedMs = law.promiseMs
      const startPromiseLoop = (): void => {
        promiseLoop?.stop()
        promiseLoop = startLocalLivenessLoop({
          timers,
          dueMs: ingestStartedAt + promisedMs - timers.now(),
          probe: () => law.seam.probe(),
          onAlive: () => {
            if (headersLanded) return null
            const sinceIngest = timers.now() - ingestStartedAt
            const extension = localPromiseExtensionMs(law.promiseMs)
            promisedMs = sinceIngest + extension
            publish({ ...wait, sinceMs: ingestStartedAt, budgetMs: promisedMs, checkedMs: sinceIngest })
            return extension
          },
          onDead: (_elapsed, unansweredMs) => {
            if (headersLanded) return
            cut.dead = { unansweredMs }
            controller.abort()
          },
        })
      }
      const watchLoading = async (): Promise<void> => {
        if (law.loadedAtSend !== false) return
        let isLoaded: boolean | null = false
        stopIngestWatch()
        const sizeGb = await law.seam.sizeGb()
        if (headersLanded) return
        publish({ ...wait, phase: 'loading', ...(sizeGb !== undefined ? { sizeGb } : {}) })
        while (!headersLanded && isLoaded === false) {
          await new Promise<void>(resolve => {
            loadingHandle = timers.setTimeout(resolve, LOCAL_LOADING_POLL_MS)
          })
          loadingHandle = null
          if (headersLanded) return
          isLoaded = await law.seam.loaded()
        }
        if (headersLanded) return
        ingestStartedAt = timers.now()
        promisedMs = law.promiseMs
        publish({ ...wait, sinceMs: ingestStartedAt, budgetMs: promisedMs })
        startPromiseLoop()
      }
      if (law.loadedAtSend !== false) startPromiseLoop()
      void watchLoading().catch(() => undefined)
    }
    try {
      const fetchImpl = options.fetchImpl ?? getApiFetch()
      const fetchOptions = options.fetchImpl ? {} : localFetchOptions()
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
        ...fetchOptions,
      } as RequestInit)
    } catch (error) {
      headersLanded = true
      if (firstByteTimer !== null) timers.clearTimeout(firstByteTimer)
      stopIngestWatch()
      const cancelled = options.signal?.aborted === true
      if (!cancelled && local !== undefined && cut.dead !== null) {
        yield fault({ kind: 'timeout', code: LOCAL_DEAD_SERVER_CODE, message: localDeadServerLine(local.serverWords, cut.dead.unansweredMs, 'ingesting'), retryable: false })
        return
      }
      if (!cancelled && local !== undefined && cut.cap) {
        yield fault({ kind: 'timeout', code: LOCAL_CAP_CODE, message: localCapLine(wait.model, timers.now() - requestStartedAt, 'ingesting'), retryable: false })
        return
      }
      if (!cancelled && firstByteFired) {
        yield fault({ kind: 'timeout', code: 'first-byte-timeout', message: firstByteTimeoutLine(wait), retryable: true })
        return
      }
      const outage = cancelled ? null : outageCauseOfFetchFailure(error)
      yield fault(
        cancelled
          ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled before response', retryable: false }
          : { kind: 'transport-error', code: 'fetch-failed', message: describeTransportFailure(error, options.url), retryable: true, ...(outage !== null ? { outage } : {}) },
      )
      return
    }
    headersLanded = true
    ingestMs = timers.now() - ingestStartedAt
    try {
      options.onResponseHeaders?.(response.headers, response.status)
    } catch {
      void 0
    }
    if (firstByteTimer !== null) timers.clearTimeout(firstByteTimer)
    stopIngestWatch()
    publish(null)
    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      yield fault(mapCompatHttpFailure(response.status, body, response.headers))
      return
    }
    if (!response.body) {
      yield fault({ kind: 'transport-error', code: 'no-body', message: 'response had no body', retryable: true })
      return
    }
    const reader = response.body.getReader()
    const splitter = new LineSplitter()
    const watchdog = local === undefined ? createStreamIdleWatchdog({ timeoutMs: idleMs }) : null
    idleWatchdog = watchdog
    if (local !== undefined) {
      const law = local
      silenceWatch = startLocalSilenceWatch({
        timers,
        idleMs,
        probe: () => law.seam.probe(),
        onWarning: (silentMs, sinceMs) => publish({ kind: 'silence', model: wait.model, silentMs, sinceMs, answered: false, askAtMs: idleMs }),
        onAlive: (silentMs, sinceMs) => publish({ kind: 'silence', model: wait.model, silentMs, sinceMs, answered: true }),
        onResume: () => publish(null),
        onDead: (_silentMs, unansweredMs) => {
          cut.dead = { unansweredMs }
          controller.abort()
        },
      })
    }
    const relay = createStreamActivityRelay(atMs => options.onStreamActivity?.(atMs))
    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await (watchdog !== null ? watchdog.guard(reader.read()) : reader.read())
        watchdog?.noteActivity()
        silenceWatch?.noteActivity()
      } catch (error) {
        const isIdle = error instanceof StreamIdleTimeoutError
        const cancelled = options.signal?.aborted === true
        yield fault(
          cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : local !== undefined && cut.dead !== null
              ? { kind: 'timeout', code: LOCAL_DEAD_SERVER_CODE, message: localDeadServerLine(local.serverWords, cut.dead.unansweredMs, 'writing'), retryable: false }
              : local !== undefined && cut.cap
                ? { kind: 'timeout', code: LOCAL_CAP_CODE, message: localCapLine(wait.model, timers.now() - requestStartedAt, 'writing'), retryable: false }
                : isIdle
                  ? { kind: 'timeout', code: 'idle-timeout', message: streamIdleFaultWords(idleMs), retryable: true }
                  : { kind: 'transport-error', code: 'read-failed', message: error instanceof Error ? error.message : String(error), retryable: true },
        )
        void reader.cancel().catch(() => {})
        return
      }
      const text = chunk.done ? '' : Buffer.from(chunk.value!).toString('utf8')
      totalChars += text.length
      if (head.length < OLLAMA_WIRE_DUMP_CHARS) head += text.slice(0, OLLAMA_WIRE_DUMP_CHARS - head.length)
      const lines = chunk.done ? splitter.flush() : splitter.push(text)
      if (lines.length > 0) relay.noteEvent()
      else relay.noteChunk()
      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          yield fault({ kind: 'truncated-stream', code: 'bad-json-chunk', message: `unparseable NDJSON row: ${line.slice(0, 160)}`, retryable: false })
          continue
        }
        const outcome = decodeRow(parsed, calls, seen, shape)
        for (const event of outcome.events) {
          if (event.type === 'usage' && local !== undefined && ingestMs !== null) {
            try {
              local.noteTurn({ promptTokens: event.usage.inputTokens, cachedTokens: event.usage.cachedInputTokens, ingestMs: ingestMsOfDoneRow(parsed) ?? ingestMs })
            } catch {
              ingestMs = null
            }
          }
          if (event.type === 'finish') shape.ended = 'finish'
          if (event.type === 'stream-fault') shape.ended = `fault ${event.fault.code}`
          yield event
        }
        if (outcome.done) {
          finished = true
          break readLoop
        }
      }
      if (chunk.done) break
    }
    if (!finished) {
      yield fault({ kind: 'truncated-stream', code: 'no-finish', message: 'stream ended without a done row', retryable: true })
    }
  } finally {
    timers.clearTimeout(totalTimer)
    idleWatchdog?.stop()
    silenceWatch?.stop()
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
    if (shape.ended === 'open') shape.ended = options.signal?.aborted === true ? 'cancelled' : 'abandoned'
    logForDebugging(ollamaWireDumpLine(options.request.model, shape, head, totalChars))
  }
}
