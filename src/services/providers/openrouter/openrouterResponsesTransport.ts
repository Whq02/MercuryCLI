import type { AssistantMessage, Message } from '../../../types/message.js'
import type { MessageParam } from '../../../types/wire.js'
import { getApiFetch, getProxyFetchOptions } from '../../../utils/proxy.js'
import { getUserAgent } from '../../../utils/http.js'
import { wrapFetchWithWireDump } from '../../api/dumpPrompts.js'
import { outageCauseOfFetchFailure } from '../../api/reconnectLadder.js'
import { assistantMessageToMessageParam, userMessageToMessageParam } from '../anthropic/messageParams.js'
import { mapMessagesToOpenaiInput, type BridgeMessage, type OpenaiTurnRecord } from '../openai/responsesBridge.js'
import { mapOpenaiHttpFailure, ResponsesStreamFold, type OpenaiFault, type OpenaiInputItem, type OpenaiStreamEvent } from '../openai/openaiWire.js'
import { SseDecoder } from '../sseDecoder.js'
import {
  createStreamActivityRelay,
  createStreamIdleWatchdog,
  firstByteBudgetMs,
  firstByteTimeoutLine,
  SILENT_AFTER_HEADERS_CODE,
  silentAfterHeadersFaultWords,
  streamIdleTimeoutMs,
  StreamIdleTimeoutError,
  streamIdleFaultWords,
  type RequestWaitV1,
  type StreamIdleWatchdog,
} from '../streamIdleBudget.js'
import {
  describeTransportFailure,
  type CompatCompletedToolCall,
  type CompatDeferralFacts,
  type CompatFault,
  type CompatFinishReason,
  type CompatStreamEvent,
  type CompatStreamOptions,
  type CompatTool,
} from '../openaicompat/compatChatClient.js'

export const OPENROUTER_TOOL_SEARCH_TYPE = 'openrouter:tool_search'

const TOTAL_TIMEOUT_MS = 50 * 60_000

type Record_ = Record<string, unknown>

function asRecord(v: unknown): Record_ | undefined {
  return typeof v === 'object' && v !== null ? (v as Record_) : undefined
}

export function openrouterResponsesUrl(chatUrl: string): string {
  return chatUrl.replace(/\/chat\/completions\/?$/, '/responses')
}

export function openrouterNativeTools(tools: readonly CompatTool[], deferredNames: ReadonlySet<string>): Record_[] {
  return [
    { type: OPENROUTER_TOOL_SEARCH_TYPE },
    ...tools.map(tool => ({
      type: 'function',
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      parameters: tool.function.parameters,
      ...(deferredNames.has(tool.function.name) ? { defer_loading: true } : {}),
    })),
  ]
}

function recordAgreesWithContent(items: readonly unknown[], content: MessageParam['content']): boolean {
  const minted = new Set<string>()
  if (Array.isArray(content)) {
    for (const block of content) {
      if ((block as { type?: string }).type === 'tool_use') minted.add(String((block as { id?: unknown }).id))
    }
  }
  const recorded = new Set<string>()
  for (const item of items) {
    const rec = asRecord(item)
    if (rec?.type === 'function_call' && typeof rec.call_id === 'string') recorded.add(rec.call_id)
  }
  if (minted.size !== recorded.size) return false
  for (const id of minted) if (!recorded.has(id)) return false
  return true
}

function replayRecordOf(message: AssistantMessage, wireModel: string, content: MessageParam['content']): OpenaiTurnRecord | undefined {
  const turn = message.openrouterProviderTurn
  if (turn === undefined || !Array.isArray(turn.items) || turn.items.length === 0) return undefined
  if (typeof turn.model !== 'string' || turn.model.trim().toLowerCase() !== wireModel.trim().toLowerCase()) return undefined
  if (!recordAgreesWithContent(turn.items, content)) return undefined
  return { provider: 'openai', items: turn.items as OpenaiInputItem[] }
}

export function openrouterResponsesInput(messages: readonly Message[], wireModel: string, imagesSupported: boolean): OpenaiInputItem[] {
  const bridge: BridgeMessage[] = []
  for (const message of messages) {
    if (message.type === 'user') {
      bridge.push({ role: 'user', content: userMessageToMessageParam(message, false, false).content })
    } else if (message.type === 'assistant') {
      const param = assistantMessageToMessageParam(message, false, false)
      const turnRecord = replayRecordOf(message, wireModel, param.content)
      bridge.push({
        role: 'assistant',
        content: param.content,
        turnId: message.message.id,
        ...(turnRecord !== undefined ? { turnRecord } : {}),
      })
    }
  }
  return mapMessagesToOpenaiInput(bridge, { imagesSupported })
}

export function buildOpenrouterResponsesBody(options: CompatStreamOptions, facts: CompatDeferralFacts, messages: readonly Message[]): Record_ {
  const request = options.request
  const system = request.messages.find(m => m.role === 'system' && 'content' in m)
  const instructions = system !== undefined && 'content' in system && typeof system.content === 'string' && system.content.trim() !== '' ? system.content : undefined
  const extra = request.extra ?? {}
  const reasoning = asRecord(extra.reasoning)
  return {
    model: request.model,
    ...(extra.provider !== undefined ? { provider: extra.provider } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    input: openrouterResponsesInput(messages, request.model, facts.imagesSupported),
    tools: openrouterNativeTools(request.tools ?? [], facts.deferredNames),
    ...(reasoning !== undefined ? { reasoning: { ...reasoning, ...(reasoning.summary === undefined ? { summary: 'auto' } : {}) } } : {}),
    ...(typeof extra.max_tokens === 'number' ? { max_output_tokens: extra.max_tokens } : {}),
    stream: true,
    ...(facts.cacheDomainKey !== undefined ? { prompt_cache_key: facts.cacheDomainKey } : {}),
  }
}

export function replayableOpenrouterItems(items: readonly unknown[], mintedCallIds: ReadonlySet<string>): unknown[] {
  const seen = new Set<string>()
  const kept = items.filter(item => {
    const rec = asRecord(item)
    if (rec?.type !== 'function_call') return true
    const callId = typeof rec.call_id === 'string' ? rec.call_id : ''
    if (!mintedCallIds.has(callId) || seen.has(callId)) return false
    seen.add(callId)
    return true
  })
  return kept.filter((item, index) => {
    if (asRecord(item)?.type !== 'reasoning') return true
    const next = asRecord(kept[index + 1])
    return next !== undefined && next.type !== 'reasoning'
  })
}

function compatFaultOf(fault: OpenaiFault): CompatFault {
  const kind: CompatFault['kind'] =
    fault.kind === 'usage-limit' ? 'http-error' : fault.kind === 'response-failed' ? 'api-error' : fault.kind
  return {
    kind,
    code: fault.code,
    message: fault.message,
    retryable: fault.retryable,
    ...(fault.inStream ? { inStream: fault.inStream } : {}),
    ...(fault.status !== undefined ? { status: fault.status } : {}),
    ...(fault.retryAfterMs !== undefined ? { retryAfterMs: fault.retryAfterMs } : {}),
    ...(fault.outage !== undefined ? { outage: fault.outage } : {}),
  }
}

const FINISH_OF: Record<string, CompatFinishReason> = {
  completed: 'stop',
  tool_calls: 'tool_calls',
  max_output_tokens: 'length',
  content_filter: 'content_filter',
}

interface TurnRecordState {
  model: string
  items: unknown[]
  responseId?: string
  statedCostUSD?: number
}

function translate(event: OpenaiStreamEvent, state: TurnRecordState, slots: Map<string, number>): CompatStreamEvent[] {
  switch (event.type) {
    case 'text-delta':
    case 'refusal-delta':
      return [{ type: 'text-delta', text: event.text }]
    case 'reasoning-delta':
      return [{ type: 'reasoning-delta', text: event.text }]
    case 'tool-args-start': {
      const index = slots.size
      slots.set(event.itemId, index)
      return [{ type: 'tool-call-fragment', index, id: event.callId, name: event.name, argumentsFragment: '' }]
    }
    case 'tool-args-delta': {
      const index = slots.get(event.itemId)
      if (index === undefined) return []
      return [{ type: 'tool-call-fragment', index, argumentsFragment: event.delta }]
    }
    case 'usage':
      return [{
        type: 'usage',
        usage: {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          ...(event.usage.cachedInputTokens !== undefined ? { cachedInputTokens: event.usage.cachedInputTokens } : {}),
          ...(event.usage.reasoningOutputTokens !== undefined ? { reasoningTokens: event.usage.reasoningOutputTokens } : {}),
          ...(state.statedCostUSD !== undefined ? { statedCostUSD: state.statedCostUSD } : {}),
        },
      }]
    case 'finish': {
      const toolCalls: CompatCompletedToolCall[] = event.toolCalls.map((call, index) => ({
        index,
        id: call.callId,
        name: call.name,
        argumentsRaw: call.argumentsRaw,
        ...(call.malformed ? {} : { arguments: call.arguments }),
        malformed: call.malformed,
      }))
      const reason = FINISH_OF[event.reason] ?? 'other'
      return [{ type: 'finish', reason, rawReason: event.reason === 'other-incomplete' ? (event.incompleteDetail ?? 'incomplete') : event.reason, toolCalls }]
    }
    case 'stream-fault':
      return [{ type: 'stream-fault', fault: compatFaultOf(event.fault) }]
    default:
      return []
  }
}

function tapRaw(parsed: unknown, state: TurnRecordState): CompatStreamEvent[] {
  const o = asRecord(parsed)
  if (o === undefined) return []
  const type = typeof o.type === 'string' ? o.type : ''
  if (type === 'response.output_item.done') {
    const item = asRecord(o.item)
    if (item !== undefined) state.items.push(item)
    return []
  }
  if (type === 'response.reasoning_text.delta' && typeof o.delta === 'string' && o.delta !== '') {
    return [{ type: 'reasoning-delta', text: o.delta }]
  }
  const response = asRecord(o.response)
  if (response === undefined) return []
  const out: CompatStreamEvent[] = []
  if (type === 'response.created' && typeof response.model === 'string' && response.model.trim() !== '') {
    out.push({ type: 'served-model', model: response.model.trim() })
  }
  if (typeof response.id === 'string' && response.id !== '') state.responseId = response.id
  const usage = asRecord(response.usage)
  if (usage !== undefined && typeof usage.cost === 'number') state.statedCostUSD = usage.cost
  return out
}

export async function* streamOpenrouterResponses(options: CompatStreamOptions, body: string, state: TurnRecordState, lane: 'openrouter' | 'xai' | 'zen' = 'openrouter'): AsyncGenerator<CompatStreamEvent> {
  const idleMs = options.idleTimeoutMs ?? streamIdleTimeoutMs()
  const url = openrouterResponsesUrl(options.url)
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS)
  totalTimer.unref?.()
  let idleWatchdog: StreamIdleWatchdog | null = null
  const fold = new ResponsesStreamFold()
  const slots = new Map<string, number>()
  try {
    let response: Response
    const firstByteBudget = firstByteBudgetMs({
      cold: options.firstByte?.cold === true,
      promptTokens: options.firstByte?.promptTokens ?? 0,
      idleMs,
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
      const fetchImpl = options.fetchImpl ?? wrapFetchWithWireDump(getApiFetch(), lane)
      const proxyOptions = options.fetchImpl ? {} : getProxyFetchOptions()
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          'user-agent': getUserAgent(),
          ...(options.extraHeaders ?? {}),
        },
        body,
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
          : { kind: 'transport-error', code: 'fetch-failed', message: describeTransportFailure(error, url), retryable: true, ...(outage !== null ? { outage } : {}) },
      }
      return
    }
    clearTimeout(firstByteTimer)
    options.firstByte?.onWait?.(null)
    try {
      options.onResponseHeaders?.(response.headers, response.status)
    } catch (error) {
      void error
    }
    if (!response.ok) {
      let errorBody: unknown
      try {
        errorBody = await response.json()
      } catch {
        errorBody = undefined
      }
      yield { type: 'stream-fault', fault: compatFaultOf(mapOpenaiHttpFailure(response.status, errorBody, response.headers)) }
      return
    }
    if (!response.body) {
      yield { type: 'stream-fault', fault: { kind: 'transport-error', code: 'no-body', message: 'response had no body', retryable: true } }
      return
    }
    const reader = response.body.getReader()
    const decoder = new SseDecoder()
    const watchdog = createStreamIdleWatchdog({ timeoutMs: idleMs, silentAfterHeadersMs: options.silentAfterHeadersMs ?? null })
    idleWatchdog = watchdog
    const relay = createStreamActivityRelay(atMs => options.onStreamActivity?.(atMs))
    readLoop: for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await watchdog.guard(reader.read())
        if (!chunk.done && chunk.value.byteLength > 0) watchdog.noteActivity()
      } catch (error) {
        const cancelled = options.signal?.aborted === true
        yield {
          type: 'stream-fault',
          fault: cancelled
            ? { kind: 'cancelled', code: 'cancelled', message: 'cancelled mid-stream', retryable: false }
            : error instanceof StreamIdleTimeoutError && error.noBytes
              ? { kind: 'timeout', code: SILENT_AFTER_HEADERS_CODE, message: silentAfterHeadersFaultWords(wait.model, error.silentMs, wait.promptTokens), retryable: true }
              : error instanceof StreamIdleTimeoutError
                ? { kind: 'timeout', code: 'idle-timeout', message: streamIdleFaultWords(idleMs), retryable: true }
                : { kind: 'transport-error', code: 'read-failed', message: error instanceof Error ? error.message : String(error), retryable: true },
        }
        void reader.cancel().catch(() => {})
        return
      }
      const results = chunk.done ? decoder.flush() : decoder.push(Buffer.from(chunk.value!))
      relay.noteChunk()
      for (const item of results) {
        if (item.kind === 'fault') {
          yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'sse-dangling-event', message: `dangling SSE fragment: ${item.preview}`, retryable: false } }
          continue
        }
        const payload = item.event.data
        if (payload.trim() === '[DONE]') break readLoop
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          yield { type: 'stream-fault', fault: { kind: 'truncated-stream', code: 'bad-json-chunk', message: `unparseable SSE chunk: ${payload.slice(0, 160)}`, retryable: false } }
          continue
        }
        for (const event of tapRaw(parsed, state)) {
          relay.noteEvent()
          yield event
        }
        for (const event of fold.fold(parsed)) {
          for (const translated of translate(event, state, slots)) {
            relay.noteEvent()
            yield translated
          }
        }
        if (fold.finished) break readLoop
      }
      if (chunk.done) break
    }
    if (!fold.finished) {
      const bare = fold.takeBareStreamError()
      yield {
        type: 'stream-fault',
        fault: bare !== null
          ? compatFaultOf(bare)
          : { kind: 'truncated-stream', code: 'no-terminal-event', message: 'stream ended without response.completed/failed/incomplete', retryable: true },
      }
    }
  } finally {
    clearTimeout(totalTimer)
    idleWatchdog?.stop()
    options.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}

const MIXED_UPSTREAM_HISTORY_WORDS = /encrypted reasoning or compaction content from multiple providers/i

export function isMixedUpstreamHistoryFault(fault: CompatFault): boolean {
  return fault.kind === 'http-error' && fault.status === 400 && MIXED_UPSTREAM_HISTORY_WORDS.test(fault.message)
}

export function withoutEncryptedReasoning(input: readonly unknown[]): { input: unknown[]; dropped: number } {
  const kept = input.filter(item => {
    const rec = asRecord(item)
    return !(rec?.type === 'reasoning' && typeof rec.encrypted_content === 'string')
  })
  return { input: kept, dropped: input.length - kept.length }
}

export function mixedUpstreamRetryWords(dropped: number): string {
  return `OpenRouter refused the history: it held encrypted reasoning from more than one upstream — replaying it without the ${dropped} reasoning item${dropped === 1 ? '' : 's'}`
}

async function* streamWithMixedUpstreamRetry(options: CompatStreamOptions, bodyObject: Record_, state: TurnRecordState): AsyncGenerator<CompatStreamEvent> {
  for await (const event of streamOpenrouterResponses(options, JSON.stringify(bodyObject), state)) {
    if (event.type === 'stream-fault' && isMixedUpstreamHistoryFault(event.fault) && Array.isArray(bodyObject.input)) {
      const stripped = withoutEncryptedReasoning(bodyObject.input)
      if (stripped.dropped > 0) {
        options.firstByte?.onWait?.({ kind: 'retry', attempt: 1, of: 1, reason: mixedUpstreamRetryWords(stripped.dropped), delayMs: 0, sinceMs: Date.now() })
        yield* streamOpenrouterResponses(options, JSON.stringify({ ...bodyObject, input: stripped.input }), state)
        return
      }
    }
    yield event
  }
}

export function openrouterResponsesTransport(
  options: CompatStreamOptions,
  messages: readonly Message[],
): { events: AsyncGenerator<CompatStreamEvent>; settle(minted: readonly AssistantMessage[]): void } | undefined {
  const facts = options.deferral
  if (facts === undefined || facts.form !== 'openrouter-native') return undefined
  const state: TurnRecordState = { model: options.request.model, items: [] }
  const bodyObject = buildOpenrouterResponsesBody(options, facts, messages)
  return {
    events: streamWithMixedUpstreamRetry(options, bodyObject, state),
    settle: minted => {
      const last = minted.at(-1)
      if (last === undefined) return
      const mintedCallIds = new Set<string>()
      for (const message of minted) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') mintedCallIds.add(block.id)
        }
      }
      const items = replayableOpenrouterItems(state.items, mintedCallIds)
      if (items.length === 0) return
      last.openrouterProviderTurn = {
        model: state.model,
        items,
        ...(state.responseId !== undefined ? { responseId: state.responseId } : {}),
      }
    },
  }
}
