import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
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
import { fetchWithProviderDeadline } from '../fetchDeadline.js'
import { createStreamIdleWatchdog, streamIdleTimeoutMs, StreamIdleTimeoutError, type StreamIdleWatchdog } from '../streamIdleBudget.js'

const CATALOGUE_FETCH_TIMEOUT_MS = 15_000
const TOTAL_TIMEOUT_MS = 50 * 60_000

export interface OpenaiStreamOptions {
  baseUrl: string
  headers: Record<string, string>
  request: OpenaiResponsesRequest
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
}

export async function* streamOpenaiResponses(
  options: OpenaiStreamOptions,
): AsyncGenerator<OpenaiStreamEvent> {
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const url = `${options.baseUrl.replace(/\/$/, '')}/responses`
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()
  let idleWatchdog: StreamIdleWatchdog | null = null

  const fold = new ResponsesStreamFold()

  try {
    let response: Response
    try {
      const fetchImpl = options.fetchImpl ?? getApiFetch()
      const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': getUserAgent(),
          ...options.headers,
        },
        body: JSON.stringify(options.request),
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
              message: errorMessageWithCause(error),
              retryable: true,
            },
      }
      return
    }

    recordOpenaiRateHeaders(response.headers)

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
              ? { kind: 'timeout', code: 'idle-timeout', message: `no bytes for ${idleMs}ms`, retryable: true }
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
          yield event
        }
        if (fold.finished) break readLoop
      }
      if (chunk.done) break
    }

    if (!fold.finished) {
      yield {
        type: 'stream-fault',
        fault: {
          kind: 'truncated-stream',
          code: 'no-terminal-event',
          message: 'stream ended without response.completed/failed/incomplete',
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
  const fetchImpl = options.fetchImpl ?? getApiFetch()
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
