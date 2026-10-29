import { randomUUID } from 'node:crypto'
import type { Message } from '../../../types/message.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
import {
  createStreamActivityRelay, createStreamIdleWatchdog, firstByteBudgetMs,
  firstByteTimeoutLine, streamIdleTimeoutMs, StreamIdleTimeoutError, streamIdleFaultWords,
  SILENT_AFTER_HEADERS_CODE, silentAfterHeadersFaultWords,
  type RequestWaitV1, type StreamIdleWatchdog,
} from '../streamIdleBudget.js'
import { SseDecoder } from '../sseDecoder.js'
import {
  describeTransportFailure, mapCompatHttpFailure,
  type CompatCompletedToolCall, type CompatFinishReason, type CompatStreamEvent, type CompatStreamOptions,
} from '../openaicompat/compatChatClient.js'
import { buildGeminiPlanRequest, buildGeminiRequest, type GeminiPart, type GeminiPlanEnvelope, type GeminiRequest, type GeminiTurnItem } from './geminiCodec.js'
import { maskGeminiSecrets } from './geminiAccounts.js'
import { appendFileSync } from 'node:fs'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { fitWireImages } from '../../../utils/messages/imageRequestFit.js'
import { GEMINI_IMAGE_LIMITS } from '../../../constants/apiLimits.js'
function dumpGeminiWire(url: string, model: string, body: string): void {
  const path = flagEnv('MERCURY_GEMINI_WIRE_DUMP')?.trim()
  if (!path) return
  try {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), url, model, body: JSON.parse(body) as unknown })}\n`)
  } catch {
  }
}

export interface GeminiPlanWire extends GeminiPlanEnvelope {
  bases: readonly string[]
  userAgent: string
  onServedBy?(base: string): void
}

type GeminiStreamOptions = CompatStreamOptions & {
  messages: readonly Message[]
  stream?: boolean
  plan?: GeminiPlanWire
  apiKeyHeader?: boolean
  onTurn(item: GeminiTurnItem): void
}

export function geminiPlanStreamUrl(base: string, stream: boolean): string {
  return `${base}/v1internal:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
}

function failsOver(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const GEMINI_LENGTH_FINISH: ReadonlySet<string> = new Set(['MAX_TOKENS', 'CONTINUATION'])

const GEMINI_FILTER_FINISH: ReadonlySet<string> = new Set([
  'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'ESCALATION', 'PUP_LIMITED_DISABLED',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION',
])

export const GEMINI_MALFORMED_FUNCTION_CALL = 'MALFORMED_FUNCTION_CALL'

export function geminiMalformedCallName(finishMessage: string | undefined): string {
  const text = finishMessage ?? ''
  const named = /default_api[.:]([A-Za-z_][\w.-]*)\s*[({]/.exec(text) ?? /\bcall:([A-Za-z_][\w.-]*)\s*[({]/.exec(text) ?? /Malformed function call:\s*([A-Za-z_][\w.-]*)\s*[({]/.exec(text)
  return named?.[1] ?? ''
}

export function geminiFinishReason(finish: string, hasCalls: boolean): CompatFinishReason {
  if (finish === 'STOP' || finish === GEMINI_MALFORMED_FUNCTION_CALL) return hasCalls ? 'tool_calls' : 'stop'
  if (GEMINI_LENGTH_FINISH.has(finish)) return 'length'
  if (GEMINI_FILTER_FINISH.has(finish)) return 'content_filter'
  return 'other'
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
  let tokenWait = true
  const parts: GeminiPart[] = []
  const calls: CompatCompletedToolCall[] = []
  const nativeCalls: GeminiTurnItem['calls'] = []
  let finish: string | undefined
  let finishMessage: string | undefined
  let providerFailed = false
  let thoughtTextSeen = false
  let firstSignature: string | undefined
  let withheldSaid = false
  function* sayWithheld(): Generator<CompatStreamEvent> {
    if (withheldSaid || thoughtTextSeen || firstSignature === undefined) return
    withheldSaid = true
    yield { type: 'reasoning-withheld', signature: firstSignature }
  }
  const budgetMs = firstByteBudgetMs({ cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0, idleMs })
  const wait: Extract<RequestWaitV1, { kind: 'first-byte' }> = {
    kind: 'first-byte', cold: options.firstByte?.cold === true, promptTokens: options.firstByte?.promptTokens ?? 0,
    model: options.firstByte?.model ?? options.request.model, budgetMs, sinceMs: Date.now(), attempt: options.firstByte?.attempt ?? 1,
  }
  const safe = (value: string): string => {
    const masked = maskGeminiSecrets(value)
    return options.apiKey ? masked.split(options.apiKey).join('«masked»') : masked
  }
  function* decode(raw: unknown): Generator<CompatStreamEvent> {
    const outer = record(raw)
    const value = options.plan && outer && outer.error === undefined && outer.response !== undefined ? outer.response : raw
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
      if (thought && typeof part.text === 'string' && part.text !== '') thoughtTextSeen = true
      if (signature && firstSignature === undefined) firstSignature = signature
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
        if (text !== '' && !thought) yield* sayWithheld()
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
    if (typeof candidate?.finishMessage === 'string' && candidate.finishMessage !== '') finishMessage = candidate.finishMessage
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
    const plan = options.plan
    const urls = plan ? plan.bases.map(base => geminiPlanStreamUrl(base, stream)) : [options.url.replace(/:streamGenerateContent(?:\?alt=sse)?$/, stream ? ':streamGenerateContent?alt=sse' : ':generateContent')]
    const body = JSON.stringify(fitWireImages(plan ? buildGeminiPlanRequest(request, options.request.model, plan) : request, GEMINI_IMAGE_LIMITS).request)
    dumpGeminiWire(urls[0]!, options.request.model, body)
    options.firstByte?.onWait?.(wait)
    firstTimer = setTimeout(() => { firstByteFired = true; controller.abort() }, budgetMs)
    firstTimer.unref?.()
    let response!: Response
    for (let attempt = 0; attempt < urls.length; attempt++) {
      const last = attempt === urls.length - 1
      try {
        response = await (options.fetchImpl ?? getApiFetch())(urls[attempt]!, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', ...(options.apiKeyHeader ? { 'x-goog-api-key': options.apiKey ?? '' } : { authorization: `Bearer ${options.apiKey}` }), 'user-agent': plan?.userAgent ?? getUserAgent() },
          body, signal: controller.signal,
          ...(options.fetchImpl ? {} : getProxyFetchOptions()),
        })
      } catch (error) {
        if (!last && !controller.signal.aborted) continue
        throw error
      }
      if (!last && failsOver(response.status)) {
        await response.body?.cancel().catch(() => {})
        continue
      }
      if (response.ok && plan) plan.onServedBy?.(plan.bases[attempt]!)
      break
    }
    headersReceived = true
    clearTimeout(firstTimer)
    options.firstByte?.onWait?.(response.ok && stream ? { ...wait, phase: 'tokens' } : null)
    options.onResponseHeaders?.(response.headers, response.status)
    watchdog = createStreamIdleWatchdog({ timeoutMs: idleMs, silentAfterHeadersMs: response.ok && stream ? options.silentAfterHeadersMs ?? null : null })
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
        if (!chunk.done && chunk.value.byteLength > 0) watchdog.noteActivity()
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
          for (const decoded of decode(value)) {
            if (tokenWait && (decoded.type === 'text-delta' || decoded.type === 'reasoning-delta' || decoded.type === 'reasoning-withheld' || decoded.type === 'tool-call-fragment')) {
              tokenWait = false
              options.firstByte?.onWait?.(null)
            }
            yield decoded
          }
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
    if (finish === GEMINI_MALFORMED_FUNCTION_CALL) {
      const detail = finishMessage ?? 'Gemini gave no detail'
      calls.push({ index: calls.length, id: `gemini_${randomUUID()}`, name: geminiMalformedCallName(finishMessage), argumentsRaw: finishMessage ?? '', malformed: true, providerRefusal: `Gemini could not parse the function call the model wrote (${GEMINI_MALFORMED_FUNCTION_CALL}): ${safe(detail)}` })
    }
    yield* sayWithheld()
    options.onTurn({ model: options.request.model, parts, calls: nativeCalls, projection: '' })
    const reason = geminiFinishReason(finish, calls.length > 0)
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
        : idle && error.noBytes
          ? { kind: 'timeout', code: SILENT_AFTER_HEADERS_CODE, silentMs: error.silentMs, message: silentAfterHeadersFaultWords(wait.model, error.silentMs, wait.promptTokens), retryable: true }
          : idle
            ? { kind: 'timeout', code: 'idle-timeout', silentMs: error.silentMs, message: streamIdleFaultWords(idleMs), retryable: true }
            : { kind: headersReceived ? 'truncated-stream' : 'transport-error', code: headersReceived ? 'read-failed' : 'fetch-failed', message: safe(describeTransportFailure(error, options.url)), retryable: true, ...(outage !== null ? { outage } : {}) } }
  } finally {
    if (firstTimer) clearTimeout(firstTimer)
    options.firstByte?.onWait?.(null)
    watchdog?.stop()
    options.signal?.removeEventListener('abort', abort)
    abort()
  }
}
