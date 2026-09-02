import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { SseDecoder } from '../sseDecoder.js'
import { compatStreamIdleTimeoutMs } from '../streamIdleBudget.js'

const IDLE_TIMEOUT_MS = compatStreamIdleTimeoutMs()
const TOTAL_TIMEOUT_MS = 50 * 60_000


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
  extra?: Record<string, unknown>
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
  status?: number
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

export function mapCompatHttpFailure(status: number, body: unknown): CompatFault {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  const err = typeof o?.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : undefined
  const stringError = typeof o?.error === 'string' && o.error.trim() !== '' ? o.error : undefined
  const message = String(err?.message ?? stringError ?? o?.message ?? `HTTP ${status}`)
  const word = vendorErrorWord(err)
  return {
    kind: word !== undefined ? 'api-error' : 'http-error',
    code: word !== undefined ? `api-${word}` : `http-${status}`,
    message,
    retryable: status === 429 || status === 408 || status >= 500,
    status,
  }
}


export interface CompatStreamOptions {
  apiKey?: string
  url: string
  request: CompatChatRequest
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  idleTimeoutMs?: number
  extraHeaders?: Record<string, string>
  onResponseHeaders?: (headers: Headers, status?: number) => void
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
