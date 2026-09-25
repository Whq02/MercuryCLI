import { randomUUID } from 'node:crypto'
import type { Message } from '../../../types/message.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
import {
  createStreamActivityRelay, createStreamIdleWatchdog, firstByteBudgetMs,
  firstByteTimeoutLine, streamIdleTimeoutMs, StreamIdleTimeoutError, streamIdleFaultWords,
  type RequestWaitV1, type StreamIdleWatchdog,
} from '../streamIdleBudget.js'
import { SseDecoder } from '../sseDecoder.js'
import {
  describeTransportFailure, mapCompatHttpFailure,
  type CompatCompletedToolCall, type CompatStreamEvent, type CompatStreamOptions,
} from '../openaicompat/compatChatClient.js'
import { buildGeminiRequest, type GeminiPart, type GeminiRequest, type GeminiTurnItem } from './geminiCodec.js'
import { maskGeminiSecrets } from './geminiAccounts.js'

export type GeminiStreamOptions = CompatStreamOptions & {
  messages: readonly Message[]
  stream?: boolean
  onTurn(item: GeminiTurnItem): void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export async function* streamGeminiContent(options: GeminiStreamOptions): AsyncGenerator<CompatStreamEvent> {
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) controller.abort()
  let watchdog: StreamIdleWatchdog | undefined
  let firstTimer: ReturnType<typeof setTimeout> | undefined
  let firstByteFired = false
  let headersReceived = false
  const parts: GeminiPart[] = []
  const calls: CompatCompletedToolCall[] = []
  const nativeCalls: GeminiTurnItem['calls'] = []
  let finish: string | undefined
  let providerFailed = false
  const budgetMs = firstByteBudgetMs({ cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0, idleMs })
  const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
    kind: 'first-byte', cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0,
    model: options.firstByte?.model ?? options.request.model, budgetMs, sinceMs: Date.now(), attempt: options.firstByte?.attempt ?? 1,
  }
  const safe = (value: string): string => {
    const masked = maskGeminiSecrets(value)
    return options.apiKey ? masked.split(options.apiKey).join('«masked»') : masked
  }
  function* decode(value: unknown): Generator<CompatStreamEvent> {
    const body = record(value)
    if (!body) {
      providerFailed = true
      yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'invalid-gemini-response', message: 'Gemini returned a non-object response', retryable: false } }
      return
    }
    if (body.error !== undefined) {
      const error = record(body.error)
      const fault = mapCompatHttpFailure(typeof error?.code === 'number' ? error.code : 500, body)
      providerFailed = true
      yield { type: 'stream-fault', fault: { ...fault, message: safe(fault.message), retryable: false } }
      return
    }
    const candidates = Array.isArray(body.candidates) ? body.candidates : []
    const candidate = record(candidates.find(value => record(value)?.index === 0) ?? candidates[0])
    const feedback = record(body.promptFeedback)
    if (!candidate && typeof feedback?.blockReason === 'string') {
      finish = feedback.blockReason
      providerFailed = true
      yield { type: 'stream-fault', fault: { kind: 'provider-termination', code: `finish:${feedback.blockReason}`, message: `Gemini blocked the prompt: ${feedback.blockReason}`, retryable: false } }
      return
    }
    const content = record(candidate?.content)
    for (const raw of Array.isArray(content?.parts) ? content.parts : []) {
      const part = record(raw)
      if (!part) {
        providerFailed = true
        yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'invalid-gemini-part', message: 'Gemini returned an invalid content part', retryable: false } }
        continue
      }
      const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined
      const thought = part.thought === true
      const fn = record(part.functionCall)
      if (fn) {
        const name = typeof fn.name === 'string' ? fn.name : ''
        const nativeId = typeof fn.id === 'string' && fn.id !== '' ? fn.id : undefined
        const id = nativeId ?? `gemini_${randomUUID()}`
        const args = fn.args ?? {}
        const argumentsRaw = JSON.stringify(args)
        if (calls.some(call => call.id === id)) {
          providerFailed = true
          yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'duplicate-tool-call', message: 'Gemini repeated a function call id', retryable: false } }
          continue
        }
        const malformed = name === '' || record(args) === undefined
        calls.push({ index: calls.length, id, name, argumentsRaw, arguments: args, malformed })
        nativeCalls.push({ id, name, ...(nativeId ? { nativeId } : {}) })
        parts.push({ functionCall: { name, args, ...(nativeId ? { id: nativeId } : {}) }, ...(signature ? { thoughtSignature: signature } : {}) })
        yield { type: 'tool-call-fragment', index: calls.length - 1, id, name, argumentsFragment: argumentsRaw }
      } else if (typeof part.text === 'string' || signature) {
        const text = typeof part.text === 'string' ? part.text : ''
        const previous = parts.at(-1)
        if (previous?.text !== undefined && (previous.thought === true) === thought && previous.thoughtSignature === undefined) {
          previous.text += text
          if (signature) previous.thoughtSignature = signature
        } else if (text !== '' || signature) {
          parts.push({ text, ...(thought ? { thought: true } : {}), ...(signature ? { thoughtSignature: signature } : {}) })
        }
        if (text !== '') yield { type: thought ? 'reasoning-delta' : 'text-delta', text }
      } else if (Object.keys(part).length > 0) {
        providerFailed = true
        yield { type: 'stream-fault', fault: { kind: 'provider-termination', code: 'unsupported-gemini-content', message: 'Gemini returned content this chat cannot display', retryable: false } }
      }
    }
    const usage = record(body.usageMetadata)
    if (usage) {
      const input = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0
      const output = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0
      const reasoning = typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0
      const cached = typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0
      yield { type: 'usage', usage: { inputTokens: input, outputTokens: output + reasoning, reasoningTokens: reasoning, cachedInputTokens: cached } }
    }
    if (typeof candidate?.finishReason === 'string' && candidate.finishReason !== '') finish = candidate.finishReason
  }
  try {
    if (controller.signal.aborted) {
      yield { type: 'stream-fault', fault: { kind: 'cancelled', code: 'cancelled', message: 'cancelled before request', retryable: false } }
      return
    }
    let request: GeminiRequest
    try {
      request = buildGeminiRequest(options.request, options.messages)
    } catch (error) {
      yield { type: 'stream-fault', fault: { kind: 'api-error', code: 'gemini-request-codec', message: safe(error instanceof Error ? error.message : String(error)), retryable: false } }
      return
    }
    const stream = options.stream !== false
    const url = options.url.replace(/:streamGenerateContent(?:\?alt=sse)?$/, stream ? ':streamGenerateContent?alt=sse' : ':generateContent')
    options.firstByte?.onWait?.(wait)
    firstTimer = setTimeout(() => { firstByteFired = true; controller.abort() }, budgetMs)
    firstTimer.unref?.()
    const response = await (options.fetchImpl ?? getApiFetch())(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', authorization: `Bearer ${options.apiKey}`, 'user-agent': getUserAgent() },
      body: JSON.stringify(request), signal: controller.signal,
      ...(options.fetchImpl ? {} : getProxyFetchOptions()),
    })
    headersReceived = true
    clearTimeout(firstTimer)
    options.firstByte?.onWait?.(null)
    options.onResponseHeaders?.(response.headers, response.status)
    watchdog = createStreamIdleWatchdog({ timeoutMs: idleMs })
    if (!response.ok) {
      const text = safe(await watchdog.guard(response.text()))
      let body: unknown
      try { body = JSON.parse(text) } catch { body = { message: text || `HTTP ${response.status}` } }
      const fault = mapCompatHttpFailure(response.status, body, response.headers)
      yield { type: 'stream-fault', fault: { ...fault, message: safe(fault.message) } }
      return
    }
    if (!stream) {
      yield* decode(await watchdog.guard(response.json()))
    } else {
      if (!response.body) {
        yield { type: 'stream-fault', fault: { kind: 'transport-error', code: 'no-body', message: 'response had no body', retryable: true } }
        return
      }
      reader = response.body.getReader()
      const decoder = new SseDecoder()
      const relay = createStreamActivityRelay(at => options.onStreamActivity?.(at))
      for (;;) {
        const chunk = await watchdog.guard(reader.read())
        watchdog.noteActivity()
        const events = chunk.done ? decoder.flush() : decoder.push(Buffer.from(chunk.value))
        if (events.some(event => event.kind === 'event')) relay.noteEvent()
        else relay.noteChunk()
        for (const event of events) {
          if (event.kind === 'fault') {
            providerFailed = true
            yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'sse-dangling-event', message: 'Gemini ended with an incomplete stream event', retryable: false } }
            continue
          }
          let value: unknown
          try { value = JSON.parse(event.event.data) }
          catch {
            providerFailed = true
            yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'bad-json-chunk', message: 'Gemini returned an invalid JSON stream event', retryable: false } }
            continue
          }
          yield* decode(value)
        }
        if (chunk.done) break
      }
    }
    if (providerFailed) return
    if (!finish) {
      yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'no-finish', message: 'Gemini ended without a finish reason', retryable: true } }
      return
    }
    if (options.signal?.aborted) return
    options.onTurn({ model: options.request.model, parts, calls: nativeCalls, projection: '' })
    const reason = finish === 'STOP' ? calls.length > 0 ? 'tool_calls' : 'stop' : finish === 'MAX_TOKENS' ? 'length' : /SAFETY|BLOCKLIST|PROHIBITED_CONTENT|RECITATION|IMAGE_SAFETY/.test(finish) ? 'content_filter' : 'other'
    if (reason !== 'stop' && reason !== 'tool_calls' && reason !== 'length') {
      yield { type: 'stream-fault', fault: { kind: 'provider-termination', code: `finish:${finish}`, message: `Gemini ended the response: ${finish}`, retryable: false } }
    }
    yield { type: 'finish', reason, rawReason: finish, toolCalls: calls }
  } catch (error) {
    const cancelled = options.signal?.aborted === true
    const idle = error instanceof StreamIdleTimeoutError
    const outage = cancelled || firstByteFired || idle || headersReceived ? null : outageCauseOfFetchFailure(error)
    yield { type: 'stream-fault', fault: cancelled
      ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled', retryable: false }
      : firstByteFired
        ? { kind: 'timeout', code: 'first-byte-timeout', message: firstByteTimeoutLine(wait), retryable: true }
        : idle
          ? { kind: 'timeout', code: 'idle-timeout', message: streamIdleFaultWords(idleMs), retryable: true }
          : { kind: headersReceived ? 'truncated-stream' : 'transport-error', code: headersReceived ? 'read-failed' : 'fetch-failed', message: safe(describeTransportFailure(error, options.url)), retryable: !headersReceived, ...(outage !== null ? { outage } : {}) } }
  } finally {
    if (firstTimer) clearTimeout(firstTimer)
    options.firstByte?.onWait?.(null)
    watchdog?.stop()
    options.signal?.removeEventListener('abort', abort)
    abort()
  }
}
