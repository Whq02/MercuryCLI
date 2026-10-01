import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import type { ZaiContentPart } from '../zai/zaiClient.js'
import { getUserAgent } from '../../../utils/http.js'
import { SseDecoder } from '../sseDecoder.js'
import { outageCauseOfFetchFailure, type OutageCause } from '../../api/reconnectLadder.js'
import { retryAfterHeaderMs } from '../../api/retryAfter.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  REAL_STREAM_TIMERS,
  SILENT_AFTER_HEADERS_CODE,
  silentAfterHeadersFaultWords,
  streamIdleTimeoutMs,
  StreamIdleTimeoutError,
  streamIdleFaultWords,
  streamIdleWarningMsOf,
  type RequestWaitV1,
  type StreamIdleWatchdog,
  type StreamTimers,
} from '../streamIdleBudget.js'
import {
  LOCAL_CAP_CODE,
  LOCAL_DEAD_SERVER_CODE,
  LOCAL_LIVENESS_RECHECK_MS,
  LOCAL_LOADING_POLL_MS,
  localCapLine,
  localDeadServerLine,
  localPromiseExtensionMs,
  startLocalLivenessLoop,
  type LocalLivenessLoop,
  type LocalStreamLaw,
} from '../localLiveness.js'
import type { DeferralWireForm } from '../deferralWire.js'

const TOTAL_TIMEOUT_MS = 50 * 60_000

function unrefTimer(handle: unknown): void {
  ;(handle as { unref?: () => void } | null | undefined)?.unref?.()
}


export interface CompatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ZaiContentPart[]
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

export interface CompatToolDeclarationMessage {
  role: 'system'
  tools: CompatTool[]
}

export type CompatWireMessage = CompatMessage | CompatToolDeclarationMessage

export interface CompatChatRequest {
  model: string
  messages: CompatWireMessage[]
  tools?: CompatTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  extra?: Record<string, unknown>
}

export interface CompatDeferralFacts {
  form: DeferralWireForm
  deferredNames: ReadonlySet<string>
  conversationKey?: string
  cacheDomainKey?: string
  imagesSupported: boolean
}


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
  totalTokens?: number
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
  | { type: 'served-model'; model: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-fragment'; index: number; id?: string; name?: string; argumentsFragment: string }
  | { type: 'usage'; usage: CompatUsage }
  | {
      type: 'finish'
      reason: CompatFinishReason
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
  code: string
  message: string
  retryable: boolean
  inStream?: true
  status?: number
  retryAfterMs?: number
  outage?: OutageCause
}


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

export function mapCompatHttpFailure(status: number, body: unknown, headers?: { get(name: string): string | null }): CompatFault {
  const envelope = Array.isArray(body) ? body.find(item => item !== null && typeof item === 'object' && 'error' in item) : body
  const o = typeof envelope === 'object' && envelope !== null ? (envelope as Record<string, unknown>) : undefined
  const err = typeof o?.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : undefined
  const stringError = typeof o?.error === 'string' && o.error.trim() !== '' ? o.error : undefined
  const message = String(err?.message ?? stringError ?? o?.message ?? `HTTP ${status}`)
  const word = vendorErrorWord(err)
  const retryAfterMs = retryAfterHeaderMs(headers?.get('retry-after') ?? undefined)
  return {
    kind: word !== undefined ? 'api-error' : 'http-error',
    code: word !== undefined ? `api-${word}` : `http-${status}`,
    message,
    retryable: status === 429 || status === 408 || status >= 500,
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  }
}


export interface CompatStreamOptions {
  apiKey?: string
  url: string
  request: CompatChatRequest
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
  silentAfterHeadersMs?: number | null
  onStreamActivity?: (atMs: number) => void
  firstByte?: {
    cold: boolean
    promptTokens: number
    model: string
    attempt?: number
    onWait?: (wait: RequestWaitV1 | null) => void
  }
  extraHeaders?: Record<string, string>
  onResponseHeaders?: (headers: Headers, status?: number) => void
  timers?: StreamTimers
  local?: LocalStreamLaw
  deferral?: CompatDeferralFacts
}

interface LocalSilenceWatch {
  noteActivity(): void
  stop(): void
}

export function startLocalSilenceWatch(args: {
  timers: StreamTimers
  idleMs: number
  probe(): Promise<boolean>
  onWarning(silentMs: number, sinceMs: number): void
  onAlive(silentMs: number, sinceMs: number): void
  onResume(): void
  onDead(silentMs: number, unansweredMs: number): void
}): LocalSilenceWatch {
  const { timers, idleMs } = args
  const warnAtMs = streamIdleWarningMsOf(idleMs)
  let lastActivityAt = timers.now()
  let warned = false
  let stopped = false
  let handle: unknown = null
  let loop: LocalLivenessLoop | null = null
  function arm(): void {
    if (stopped || handle !== null) return
    const nextAt = lastActivityAt + (!warned && warnAtMs < idleMs ? warnAtMs : idleMs)
    handle = timers.setTimeout(onLocalSilenceDue, Math.max(0, nextAt - timers.now()))
  }
  function onLocalSilenceDue(): void {
    handle = null
    if (stopped || loop !== null) return
    const silent = timers.now() - lastActivityAt
    if (silent < idleMs) {
      if (!warned && silent >= warnAtMs) {
        warned = true
        args.onWarning(silent, lastActivityAt)
      }
      arm()
      return
    }
    const sinceMs = lastActivityAt
    loop = startLocalLivenessLoop({
      timers,
      dueMs: 0,
      probe: args.probe,
      onAlive: () => {
        if (stopped) return null
        if (lastActivityAt !== sinceMs) {
          loop = null
          arm()
          return null
        }
        args.onAlive(timers.now() - lastActivityAt, lastActivityAt)
        return LOCAL_LIVENESS_RECHECK_MS
      },
      onDead: (_elapsed, unansweredMs) => {
        if (stopped) return
        stopped = true
        args.onDead(timers.now() - lastActivityAt, unansweredMs)
      },
    })
  }
  arm()
  return {
    noteActivity() {
      lastActivityAt = timers.now()
      if (warned || loop !== null) {
        warned = false
        loop?.stop()
        loop = null
        args.onResume()
        arm()
      }
    },
    stop() {
      stopped = true
      loop?.stop()
      loop = null
      if (handle !== null) {
        timers.clearTimeout(handle)
        handle = null
      }
    },
  }
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

export async function* streamCompatChat(
  options: CompatStreamOptions,
): AsyncGenerator<CompatStreamEvent> {
  const { request } = options
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
  let silenceWatch: LocalSilenceWatch | null = null
  let ingestMs: number | null = null

  const toolAcc = new Map<number, ToolCallAccumulator>()
  let finished = false
  let servedSeen: string | undefined

  try {
    let response: Response
    const firstByteBudget =
      local !== undefined
        ? local.promiseMs
        : firstByteBudgetMs({
            cold: options.firstByte?.cold === true,
            promptTokens: options.firstByte?.promptTokens ?? 0,
            idleMs: idleMs,
          })
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
        let isLoaded: boolean | null = law.loadedAtSend === false ? false : await law.seam.loaded()
        if (headersLanded || isLoaded !== false) return
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
      headersLanded = true
      if (firstByteTimer !== null) timers.clearTimeout(firstByteTimer)
      stopIngestWatch()
      const cancelled = options.signal?.aborted === true
      if (!cancelled && local !== undefined && cut.dead !== null) {
        yield {
          type: 'stream-fault',
          fault: { kind: 'timeout', code: LOCAL_DEAD_SERVER_CODE, message: localDeadServerLine(local.serverWords, cut.dead.unansweredMs, 'ingesting'), retryable: false },
        }
        return
      }
      if (!cancelled && local !== undefined && cut.cap) {
        yield {
          type: 'stream-fault',
          fault: { kind: 'timeout', code: LOCAL_CAP_CODE, message: localCapLine(wait.model, timers.now() - requestStartedAt, 'ingesting'), retryable: false },
        }
        return
      }
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
              message: describeTransportFailure(error, options.url),
              retryable: true,
              ...(outage !== null ? { outage } : {}),
            },
      }
      return
    }

    headersLanded = true
    ingestMs = timers.now() - ingestStartedAt
    try {
      options.onResponseHeaders?.(response.headers, response.status)
    } catch {
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
      yield { type: 'stream-fault', fault: mapCompatHttpFailure(response.status, body, response.headers) }
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
    const watchdog = local === undefined ? createStreamIdleWatchdog({ timeoutMs: idleMs, silentAfterHeadersMs: options.silentAfterHeadersMs ?? null }) : null
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
        if (!chunk.done && chunk.value.byteLength > 0) watchdog?.noteActivity()
        silenceWatch?.noteActivity()
      } catch (error) {
        const isIdle = error instanceof StreamIdleTimeoutError
        const noBytes = isIdle && error.noBytes
        const cancelled = options.signal?.aborted === true
        yield {
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : local !== undefined && cut.dead !== null
              ? { kind: 'timeout', code: LOCAL_DEAD_SERVER_CODE, message: localDeadServerLine(local.serverWords, cut.dead.unansweredMs, 'writing'), retryable: false }
              : local !== undefined && cut.cap
                ? { kind: 'timeout', code: LOCAL_CAP_CODE, message: localCapLine(wait.model, timers.now() - requestStartedAt, 'writing'), retryable: false }
                : noBytes
                  ? { kind: 'timeout', code: SILENT_AFTER_HEADERS_CODE, message: silentAfterHeadersFaultWords(wait.model, error.silentMs, wait.promptTokens), retryable: true }
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
      const results = chunk.done ? decoder.flush() : decoder.push(Buffer.from(chunk.value!))
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
          if (event.type === 'served-model') {
            if (event.model === servedSeen) continue
            servedSeen = event.model
          }
          if (event.type === 'finish') {
            finished = true
            if (event.reason === 'content_filter' || event.reason === 'insufficient_system_resource') {
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
            finished = true
          }
          if (event.type === 'usage' && local !== undefined && ingestMs !== null) {
            try {
              local.noteTurn({ promptTokens: event.usage.inputTokens, cachedTokens: event.usage.cachedInputTokens, ingestMs })
            } catch {
              ingestMs = null
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
    timers.clearTimeout(totalTimer)
    idleWatchdog?.stop()
    silenceWatch?.stop()
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}


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

export function decodeCompatUsage(usage: Record<string, unknown>): CompatUsage | undefined {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const prompt = num(usage.prompt_tokens)
  const completion = num(usage.completion_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const details = asRecord(usage.prompt_tokens_details)
  const completionDetails = asRecord(usage.completion_tokens_details)
  const cached =
    num(usage.prompt_cache_hit_tokens) ??
    num(usage.cached_tokens) ??
    num(details?.cached_tokens)
  const reasoning = num(completionDetails?.reasoning_tokens)
  const ticks = num(usage.cost_in_usd_ticks)
  const statedCost = num(usage.cost) ?? (ticks !== undefined && Number.isFinite(ticks) && ticks >= 0 ? ticks / 1e10 : undefined)
  return {
    inputTokens: prompt ?? 0,
    outputTokens: completion ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    ...(num(usage.total_tokens) !== undefined ? { totalTokens: num(usage.total_tokens) } : {}),
    ...(statedCost !== undefined ? { statedCostUSD: statedCost } : {}),
  }
}

function decodeChunk(parsed: unknown, toolAcc: Map<number, ToolCallAccumulator>): CompatStreamEvent[] {
  const out: CompatStreamEvent[] = []
  const o = asRecord(parsed)
  const servedModel = typeof o?.model === 'string' ? o.model.trim() : ''
  if (servedModel !== '') out.push({ type: 'served-model', model: servedModel })
  const errRecord = asRecord(o?.error)
  if (errRecord !== undefined || typeof o?.error === 'string') {
    const message =
      typeof o?.error === 'string'
        ? o.error
        : String(errRecord?.message ?? JSON.stringify(errRecord).slice(0, 200))
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
