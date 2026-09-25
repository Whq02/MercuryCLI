import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { wrapFetchWithWireDump } from '../../api/dumpPrompts.js'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
import { getUserAgent } from '../../../utils/http.js'
import { errorMessageWithCause } from '../../../utils/errors.js'
import { SseDecoder } from '../sseDecoder.js'
import {
  mapOpenaiHttpFailure,
  ResponsesStreamFold,
  type OpenaiResponsesRequest,
  type OpenaiStreamEvent,
} from './openaiWire.js'
import { recordOpenaiRateHeaders } from './openaiLimitState.js'
import {
  causeWordsOf,
  composeStreamCutForensics,
  dispatcherProtocolWords,
  edgeHeadersOf,
  type StreamCutForensicsV1,
} from './streamCutForensics.js'
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
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

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const TOTAL_TIMEOUT_MS = 50 * 60_000

export interface OpenaiStreamOptions {
  baseUrl: string
  headers: Record<string, string>
  request: OpenaiResponsesRequest
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
}

export async function* streamOpenaiResponses(
  options: OpenaiStreamOptions,
): AsyncGenerator<OpenaiStreamEvent> {
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const url = `${options.baseUrl.replace(/\/$/, '')}/responses`
  const startedAtMs = Date.now()
  const body = JSON.stringify(options.request)
  const requestBytes = Buffer.byteLength(body)
  const protocol = dispatcherProtocolWords(options.fetchImpl !== undefined)
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()
  let idleWatchdog: StreamIdleWatchdog | null = null

  const fold = new ResponsesStreamFold()

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
      const fetchImpl = options.fetchImpl ?? wrapFetchWithWireDump(getApiFetch(), 'openai')
      const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': getUserAgent(),
          ...options.headers,
        },
        body,
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
      const outage = cancelled ? null : outageCauseOfFetchFailure(error)
      yield {
        type: 'stream-fault',
        fault: cancelled
          ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled before response', retryable: false }
          : {
              kind: 'transport-error',
              code: 'fetch-failed',
              message: errorMessageWithCause(error),
              retryable: true,
              ...(outage !== null ? { outage } : {}),
            },
      }
      return
    }

    clearTimeout(firstByteTimer)
    options.firstByte?.onWait?.(null)

    recordOpenaiRateHeaders(response.headers)
    const headersAtMs = Date.now()
    const edgeHeaders = edgeHeadersOf(response.headers)

    if (!response.ok) {
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      yield { type: 'stream-fault', fault: mapOpenaiHttpFailure(response.status, body, response.headers) }
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

    let bytes = 0
    let events = 0
    let lastByteAtMs = headersAtMs
    const seen = { textDeltas: 0, reasoningDeltas: 0, toolArgumentDeltas: 0, last: 'none' }
    const forensics = (cause?: string): StreamCutForensicsV1 =>
      composeStreamCutForensics({
        nowMs: Date.now(),
        startedAtMs,
        headersAtMs,
        lastByteAtMs,
        bytes,
        events,
        textDeltas: seen.textDeltas,
        reasoningDeltas: seen.reasoningDeltas,
        toolArgumentDeltas: seen.toolArgumentDeltas,
        last: seen.last,
        itemsSettled: fold.settledItems().length,
        headers: edgeHeaders,
        requestBytes,
        protocol,
        ...(cause !== undefined ? { cause } : {}),
      })
    const noteEvent = (event: OpenaiStreamEvent): void => {
      seen.last = event.type
      if (event.type === 'text-delta' || event.type === 'refusal-delta') seen.textDeltas += 1
      else if (event.type === 'reasoning-delta') seen.reasoningDeltas += 1
      else if (event.type === 'tool-args-delta') seen.toolArgumentDeltas += 1
    }

    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await watchdog.guard(reader.read())
        watchdog.noteActivity()
        if (!chunk.done && chunk.value !== undefined) {
          bytes += chunk.value.length
          lastByteAtMs = Date.now()
        }
      } catch (error) {
        const isIdle = error instanceof StreamIdleTimeoutError
        const cancelled = options.signal?.aborted === true
        yield {
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : isIdle
              ? { kind: 'timeout', code: 'idle-timeout', message: streamIdleFaultWords(idleMs), retryable: true, forensics: forensics() }
              : {
                  kind: 'transport-error',
                  code: 'read-failed',
                  message: error instanceof Error ? error.message : String(error),
                  retryable: true,
                  forensics: forensics(causeWordsOf(error)),
                },
          settledItems: fold.settledItems(),
        }
        void reader.cancel().catch(() => {})
        return
      }
      const results = chunk.done ? decoder.flush() : decoder.push(Buffer.from(chunk.value!))
      const eventCount = results.reduce((n, item) => n + (item.kind === 'event' ? 1 : 0), 0)
      events += eventCount
      if (eventCount > 0) relay.noteEvent()
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
        if (payload.trim() === '[DONE]') break readLoop
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
        for (const event of fold.fold(parsed)) {
          noteEvent(event)
          yield event
        }
        if (fold.finished) break readLoop
      }
      if (chunk.done) break
    }

    if (!fold.finished) {
      const bare = fold.takeBareStreamError()
      if (bare !== null) {
        yield { type: 'stream-fault', fault: { ...bare, forensics: forensics() }, settledItems: fold.settledItems() }
        return
      }
      yield {
        type: 'stream-fault',
        fault: {
          kind: 'truncated-stream',
          code: 'no-terminal-event',
          message: 'stream ended without response.completed/failed/incomplete',
          retryable: true,
          forensics: forensics(),
        },
        settledItems: fold.settledItems(),
      }
    }
  } finally {
    clearTimeout(totalTimer)
    idleWatchdog?.stop()
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}


export interface OpenaiLiveModel {
  id: string
  displayName?: string
  defaultReasoningEffort?: string
  supportedReasoningEfforts: string[]
  reasoningEffortsStated: boolean
  visibility?: string
  supportedInApi?: boolean
  priority?: number
  contextWindow?: number
  maxContextWindow?: number
  inputModalities?: string[]
}

export interface OpenaiCatalogueResult {
  models: OpenaiLiveModel[]
  fetchedAtMs: number
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function decodeLiveModel(raw: unknown): OpenaiLiveModel | undefined {
  const o = asRecord(raw)
  if (!o) return undefined
  const id = typeof o.slug === 'string' ? o.slug : typeof o.id === 'string' ? o.id : ''
  if (!id) return undefined
  const efforts: string[] = []
  const stated = Array.isArray(o.supported_reasoning_levels)
  const levels = stated ? (o.supported_reasoning_levels as unknown[]) : []
  for (const level of levels) {
    if (typeof level === 'string') efforts.push(level)
    else {
      const rec = asRecord(level)
      const value =
        typeof rec?.effort === 'string'
          ? rec.effort
          : typeof rec?.value === 'string'
            ? rec.value
            : typeof rec?.level === 'string'
              ? rec.level
              : undefined
      if (value) efforts.push(value)
    }
  }
  const modalities = Array.isArray(o.input_modalities)
    ? o.input_modalities.filter((m): m is string => typeof m === 'string')
    : undefined
  return {
    id,
    ...(typeof o.display_name === 'string' ? { displayName: o.display_name } : {}),
    ...(typeof o.default_reasoning_level === 'string'
      ? { defaultReasoningEffort: o.default_reasoning_level }
      : {}),
    supportedReasoningEfforts: efforts,
    reasoningEffortsStated: stated,
    ...(typeof o.visibility === 'string' ? { visibility: o.visibility } : {}),
    ...(typeof o.supported_in_api === 'boolean' ? { supportedInApi: o.supported_in_api } : {}),
    ...(typeof o.priority === 'number' ? { priority: o.priority } : {}),
    ...(typeof o.context_window === 'number' ? { contextWindow: o.context_window } : {}),
    ...(typeof o.max_context_window === 'number'
      ? { maxContextWindow: o.max_context_window }
      : {}),
    ...(modalities ? { inputModalities: modalities } : {}),
  }
}

function openaiClientVersionParam(): string {
  return MACRO.VERSION.split('-')[0] ?? MACRO.VERSION
}

export async function fetchOpenaiLiveModels(options: {
  baseUrl: string
  headers: Record<string, string>
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<OpenaiCatalogueResult> {
  // global fetch beside the bundled dispatcher and failed on every node run.
  const fetchImpl = options.fetchImpl ?? wrapFetchWithWireDump(getApiFetch(), 'openai')
  const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
  const response = await fetchWithProviderDeadline(
    fetchImpl,
    'openai',
    CATALOGUE_FETCH_TIMEOUT_MS,
    `${options.baseUrl.replace(/\/$/, '')}/models?client_version=${encodeURIComponent(openaiClientVersionParam())}`,
    {
    method: 'GET',
    headers: { 'user-agent': getUserAgent(), ...options.headers },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(proxyOptions as Record<string, unknown>),
  } as RequestInit)
  recordOpenaiRateHeaders(response.headers)
  if (!response.ok) {
    throw new Error(`http-${response.status}`)
  }
  const body = (await response.json()) as Record<string, unknown>
  const rows = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : []
  const models: OpenaiLiveModel[] = []
  for (const raw of rows) {
    const decoded = decodeLiveModel(raw)
    if (decoded) models.push(decoded)
  }
  return { models, fetchedAtMs: Date.now() }
}
