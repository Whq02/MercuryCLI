
import { logForDebugging } from '../../../utils/debug.js'
import type { StreamCapabilityAdvertisement, TextPhase } from '../../../types/wire.js'


export interface OpenaiFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: unknown
  strict?: boolean
}

export interface OpenaiWebSearchTool {
  type: 'web_search'
  filters?: { allowed_domains: string[] }
}

export interface OpenaiMessageItem {
  type: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: Array<
    | { type: 'input_text'; text: string }
    | { type: 'output_text'; text: string }
    | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }
  >
  phase?: TextPhase
}

export interface OpenaiFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
  id?: string
}

export type OpenaiFunctionCallOutputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }

export interface OpenaiFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string | OpenaiFunctionCallOutputPart[]
}

export interface OpenaiReasoningItem {
  type: 'reasoning'
  id?: string
  summary: Array<{ type: 'summary_text'; text: string }>
  content?: unknown[]
  encrypted_content?: string
}

export type OpenaiInputItem =
  | OpenaiMessageItem
  | OpenaiFunctionCallItem
  | OpenaiFunctionCallOutputItem
  | OpenaiReasoningItem

export interface OpenaiResponsesRequest {
  model: string
  instructions?: string
  input: OpenaiInputItem[]
  tools?: Array<OpenaiFunctionTool | OpenaiWebSearchTool>
  tool_choice?: 'auto'
  parallel_tool_calls?: boolean
  reasoning?: { effort?: string; summary?: 'auto' | 'concise' | 'detailed' }
  store: boolean
  stream: true
  include?: string[]
  prompt_cache_key?: string
  text?: {
    verbosity?: 'low' | 'medium' | 'high'
    format?: {
      type: 'json_schema'
      name: string
      schema: { [key: string]: unknown }
      strict?: boolean
    }
  }
}


export interface OpenaiUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  reasoningOutputTokens?: number
}

export interface OpenaiCompletedToolCall {
  callId: string
  itemId?: string
  name: string
  argumentsRaw: string
  arguments?: unknown
  malformed: boolean
}

export type OpenaiFinishReason = 'completed' | 'tool_calls' | 'max_output_tokens' | 'content_filter' | 'other-incomplete'

export interface OpenaiFault {
  kind:
    | 'http-error'
    | 'api-error'
    | 'response-failed'
    | 'truncated-stream'
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
    | 'usage-limit'
  code: string
  message: string
  retryable: boolean
  resetsAtMs?: number
  status?: number
}

export type OpenaiStreamEvent =
  | { type: 'response-id'; id: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'refusal-delta'; text: string }
  | { type: 'text-item-start'; phase?: TextPhase }
  | { type: 'text-item-done'; phase?: TextPhase }
  | { type: 'tool-args-start'; itemId: string; callId: string; name: string }
  | { type: 'tool-args-delta'; itemId: string; delta: string }
  | { type: 'tool-args-done'; itemId: string; argsRaw: string }
  | { type: 'usage'; usage: OpenaiUsage }
  | { type: 'web-search-call'; id: string; query?: string }
  | {
      type: 'finish'
      reason: OpenaiFinishReason
      toolCalls: OpenaiCompletedToolCall[]
      webSearchCalls: Array<{ id: string; query?: string }>
      citations: Array<{ url: string; title: string }>
      reasoningItems: OpenaiReasoningItem[]
      orderedItems: OpenaiInputItem[]
      finalText: string
      refusalText: string
      unknownItemTypes: string[]
      incompleteDetail?: string
      responseId?: string
    }
  | {
      type: 'stream-fault'
      fault: OpenaiFault
      settledItems?: OpenaiInputItem[]
    }

export const OPENAI_STREAM_ADVERTISEMENT: StreamCapabilityAdvertisement = {
  textDelta: true,
  reasoningDelta: true,
  toolArgsDelta: true,
  usage: true,
  timing: true,
}


const RETRYABLE_OPENAI_CODES = new Set([
  'rate_limit_exceeded',
  'server_error',
  'service_unavailable',
  'overloaded',
])

export function mapOpenaiHttpFailure(
  status: number,
  body: unknown,
  headers?: { get(name: string): string | null },
): OpenaiFault {
  const o = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
  const err =
    typeof o?.error === 'object' && o.error !== null ? (o.error as Record<string, unknown>) : undefined
  const code = typeof err?.code === 'string' ? err.code : undefined
  const errType = typeof err?.type === 'string' ? err.type : undefined
  const message = String(err?.message ?? o?.detail ?? `HTTP ${status}`)
  if (status === 429) {
    const resetFacts: string[] = []
    let resetsAtMs: number | undefined
    const resetsInSeconds = err?.resets_in_seconds ?? o?.resets_in_seconds
    if (typeof resetsInSeconds === 'number' && resetsInSeconds > 0) {
      resetsAtMs = Date.now() + resetsInSeconds * 1000
      const hours = resetsInSeconds / 3600
      resetFacts.push(
        hours >= 48
          ? `resets in ~${(hours / 24).toFixed(1)} days`
          : hours >= 1
            ? `resets in ~${hours.toFixed(1)}h`
            : `resets in ~${Math.ceil(resetsInSeconds / 60)}m`,
      )
    }
    const planType = err?.plan_type ?? o?.plan_type
    if (typeof planType === 'string' && planType) resetFacts.push(`plan: ${planType}`)
    for (const header of [
      'retry-after',
      'x-codex-primary-reset-after-seconds',
      'x-ratelimit-reset-requests',
      'x-ratelimit-reset-tokens',
    ]) {
      const value = headers?.get(header)
      if (value && resetFacts.length === 0) {
        resetFacts.push(`${header}: ${value}`)
        const seconds = Number(value)
        if (resetsAtMs === undefined && Number.isFinite(seconds) && seconds > 0) {
          resetsAtMs = Date.now() + seconds * 1000
        }
      }
    }
    return {
      kind: 'usage-limit',
      code: code || errType ? `openai-${code ?? errType}` : 'http-429',
      message: resetFacts.length > 0 ? `${message} (${resetFacts.join(' · ')})` : message,
      retryable: true,
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
      status,
    }
  }
  if (code || errType) {
    return {
      kind: 'api-error',
      code: `openai-${code ?? errType}`,
      message,
      retryable: RETRYABLE_OPENAI_CODES.has(code ?? '') || status >= 500,
      status,
    }
  }
  return {
    kind: 'http-error',
    code: `http-${status}`,
    message,
    retryable: status >= 500,
    status,
  }
}


function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function readMessagePhase(item: Record<string, unknown>): TextPhase | undefined {
  return item.phase === 'commentary' || item.phase === 'final_answer' ? item.phase : undefined
}

export function stripNullArgs(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v !== null) out[k] = v
  }
  return out
}

function parseToolCall(item: Record<string, unknown>): OpenaiCompletedToolCall {
  const rawArgs = typeof item.arguments === 'string' ? item.arguments : ''
  const callId = typeof item.call_id === 'string' ? item.call_id : ''
  const name = typeof item.name === 'string' ? item.name : ''
  let parsed: unknown
  let malformed = false
  const raw = rawArgs.trim() === '' ? '{}' : rawArgs
  try {
    parsed = stripNullArgs(JSON.parse(raw))
  } catch {
    malformed = true
  }
  if (!callId || !name) malformed = true
  return {
    callId: callId || `missing-call-id`,
    ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
    name,
    argumentsRaw: rawArgs,
    ...(malformed ? {} : { arguments: parsed }),
    malformed,
  }
}

function parseReasoningItem(item: Record<string, unknown>): OpenaiReasoningItem {
  const summaryRaw = Array.isArray(item.summary) ? item.summary : []
  const summary: OpenaiReasoningItem['summary'] = []
  for (const s of summaryRaw) {
    const rec = asRecord(s)
    if (rec?.type === 'summary_text' && typeof rec.text === 'string') {
      summary.push({ type: 'summary_text', text: rec.text })
    }
  }
  return {
    type: 'reasoning',
    ...(typeof item.id === 'string' ? { id: item.id } : {}),
    summary,
    ...(Array.isArray(item.content) ? { content: item.content } : {}),
    ...(typeof item.encrypted_content === 'string'
      ? { encrypted_content: item.encrypted_content }
      : {}),
  }
}

function parseUsage(usage: Record<string, unknown>): OpenaiUsage {
  const inputDetails = asRecord(usage.input_tokens_details)
  const outputDetails = asRecord(usage.output_tokens_details)
  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    ...(typeof inputDetails?.cached_tokens === 'number'
      ? { cachedInputTokens: inputDetails.cached_tokens }
      : {}),
    ...(typeof inputDetails?.cache_write_tokens === 'number'
      ? { cacheWriteInputTokens: inputDetails.cache_write_tokens }
      : {}),
    ...(typeof outputDetails?.reasoning_tokens === 'number'
      ? { reasoningOutputTokens: outputDetails.reasoning_tokens }
      : {}),
  }
}

let bareStreamErrors = 0

export function bareStreamErrorCount(): number {
  return bareStreamErrors
}

const ordinal = (n: number): string => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`)

export function bareStreamErrorFault(nth: number): OpenaiFault {
  return {
    kind: 'response-failed',
    code: 'openai-stream-error',
    message: `the provider ended the stream with an error carrying no reason — no code, no message (the ${ordinal(nth)} this session)`,
    retryable: true,
  }
}

export class ResponsesStreamFold {
  finished = false
  private bareStreamError: OpenaiFault | null = null
  takeBareStreamError(): OpenaiFault | null {
    const held = this.bareStreamError
    this.bareStreamError = null
    return held
  }
  settledItems(): OpenaiInputItem[] {
    return [...this.orderedItems]
  }
  private responseId: string | undefined
  private toolCalls: OpenaiCompletedToolCall[] = []
  private argDeltas = new Map<string, string>()
  private toolIdentity = new Map<string, { callId: string; name: string }>()
  private reasoningItems: OpenaiReasoningItem[] = []
  private orderedItems: OpenaiInputItem[] = []
  private textParts: string[] = []
  private refusalParts: string[] = []
  private unknownItemTypes = new Set<string>()
  private webSearchCalls: Array<{ id: string; query?: string }> = []
  private citations: Array<{ url: string; title: string }> = []
  private citationUrls = new Set<string>()
  private usage: OpenaiUsage | undefined
  private streamedTextChars = 0
  private settledTextChars = 0

  fold(parsed: unknown): OpenaiStreamEvent[] {
    const out: OpenaiStreamEvent[] = []
    const o = asRecord(parsed)
    if (!o) return out
    const eventType = typeof o.type === 'string' ? o.type : ''

    switch (eventType) {
      case 'response.created': {
        const response = asRecord(o.response)
        const id = typeof response?.id === 'string' ? response.id : undefined
        if (id && !this.responseId) {
          this.responseId = id
          out.push({ type: 'response-id', id })
        }
        break
      }
      case 'response.output_text.delta': {
        if (typeof o.delta === 'string' && o.delta !== '') {
          this.streamedTextChars += o.delta.length
          out.push({ type: 'text-delta', text: o.delta })
        }
        break
      }
      case 'response.reasoning_summary_text.delta': {
        if (typeof o.delta === 'string' && o.delta !== '') {
          out.push({ type: 'reasoning-delta', text: o.delta })
        }
        break
      }
      case 'response.refusal.delta': {
        if (typeof o.delta === 'string' && o.delta !== '') {
          out.push({ type: 'refusal-delta', text: o.delta })
        }
        break
      }
      case 'response.output_item.added': {
        const item = asRecord(o.item)
        if (item?.type === 'function_call') {
          const itemId = typeof item.id === 'string' ? item.id : ''
          const callId = typeof item.call_id === 'string' ? item.call_id : ''
          const name = typeof item.name === 'string' ? item.name : ''
          if (itemId && callId && name) {
            this.toolIdentity.set(itemId, { callId, name })
            out.push({ type: 'tool-args-start', itemId, callId, name })
          }
        } else if (item?.type === 'message') {
          const phase = readMessagePhase(item)
          out.push({ type: 'text-item-start', ...(phase ? { phase } : {}) })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const itemId = typeof o.item_id === 'string' ? o.item_id : ''
        const delta = typeof o.delta === 'string' ? o.delta : ''
        if (itemId && delta) {
          this.argDeltas.set(itemId, (this.argDeltas.get(itemId) ?? '') + delta)
          if (this.toolIdentity.has(itemId)) {
            out.push({ type: 'tool-args-delta', itemId, delta })
          }
        }
        return out
      }
      case 'response.output_item.done': {
        const item = asRecord(o.item)
        const itemType = typeof item?.type === 'string' ? item.type : ''
        if (!item) break
        if (itemType === 'function_call') {
          const itemId = typeof item.id === 'string' ? item.id : ''
          const doneArgs = typeof item.arguments === 'string' ? item.arguments.trim() : ''
          if (doneArgs === '' && itemId && this.argDeltas.has(itemId)) {
            item.arguments = this.argDeltas.get(itemId)!
          }
          if (itemId) this.argDeltas.delete(itemId)
          const call = parseToolCall(item)
          this.toolCalls.push(call)
          if (itemId && this.toolIdentity.has(itemId)) {
            this.toolIdentity.delete(itemId)
            out.push({ type: 'tool-args-done', itemId, argsRaw: call.argumentsRaw })
          }
          if (!call.malformed) {
            this.orderedItems.push({
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              arguments: call.argumentsRaw.trim() === '' ? '{}' : call.argumentsRaw,
              ...(call.itemId ? { id: call.itemId } : {}),
            })
          }
        } else if (itemType === 'reasoning') {
          const reasoning = parseReasoningItem(item)
          this.reasoningItems.push(reasoning)
          this.orderedItems.push(reasoning)
        } else if (itemType === 'message') {
          const content = Array.isArray(item.content) ? item.content : []
          const itemTexts: string[] = []
          for (const part of content) {
            const rec = asRecord(part)
            if (rec?.type === 'output_text' && typeof rec.text === 'string') {
              this.textParts.push(rec.text)
              itemTexts.push(rec.text)
              for (const raw of Array.isArray(rec.annotations) ? rec.annotations : []) {
                const annotation = asRecord(raw)
                if (annotation?.type === 'url_citation' && typeof annotation.url === 'string') {
                  this.addCitation(annotation.url, typeof annotation.title === 'string' ? annotation.title : '')
                }
              }
            } else if (rec?.type === 'refusal' && typeof rec.refusal === 'string') {
              this.refusalParts.push(rec.refusal)
            }
          }
          const joinedItemText = itemTexts.join('')
          if (joinedItemText.length > 0) {
            const alreadyStreamed = Math.max(
              0,
              Math.min(joinedItemText.length, this.streamedTextChars - this.settledTextChars),
            )
            const unstreamed = joinedItemText.slice(alreadyStreamed)
            if (unstreamed !== '') {
              this.streamedTextChars += unstreamed.length
              out.push({ type: 'text-delta', text: unstreamed })
            }
            this.settledTextChars += joinedItemText.length
          }
          const phase = readMessagePhase(item)
          if (itemTexts.length > 0) {
            this.orderedItems.push({
              type: 'message',
              role: 'assistant',
              content: itemTexts.map(text => ({ type: 'output_text' as const, text })),
              ...(phase ? { phase } : {}),
            })
          }
          out.push({ type: 'text-item-done', ...(phase ? { phase } : {}) })
        } else if (itemType === 'web_search_call') {
          const id = typeof item.id === 'string' && item.id !== '' ? item.id : `ws_${this.webSearchCalls.length + 1}`
          const action = asRecord(item.action)
          const query = typeof action?.query === 'string' && action.query !== '' ? action.query : undefined
          this.webSearchCalls.push({ id, ...(query !== undefined ? { query } : {}) })
          out.push({ type: 'web-search-call', id, ...(query !== undefined ? { query } : {}) })
        } else if (itemType !== '') {
          this.unknownItemTypes.add(itemType)
        }
        break
      }
      case 'response.output_text.annotation.added': {
        const annotation = asRecord(o.annotation)
        if (annotation?.type === 'url_citation' && typeof annotation.url === 'string') {
          this.addCitation(annotation.url, typeof annotation.title === 'string' ? annotation.title : '')
        }
        break
      }
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete': {
        this.bareStreamError = null
        const response = asRecord(o.response)
        const usage = asRecord(response?.usage)
        if (usage) {
          this.usage = parseUsage(usage)
          out.push({ type: 'usage', usage: this.usage })
        }
        if (eventType === 'response.failed') {
          const error = asRecord(response?.error)
          const code = typeof error?.code === 'string' ? error.code : 'response-failed'
          out.push({
            type: 'stream-fault',
            fault: {
              kind: 'response-failed',
              code: `openai-${code}`,
              message: String(error?.message ?? 'the provider marked the response failed'),
              retryable: RETRYABLE_OPENAI_CODES.has(code),
            },
          })
        }
        this.finished = true
        out.push(this.buildFinish(eventType, response))
        break
      }
      case 'error': {
        try {
          logForDebugging(`[openai-wire] raw stream error event: ${JSON.stringify(o)}`)
        } catch {
          logForDebugging('[openai-wire] raw stream error event: <unserializable>')
        }
        const hadCode = typeof o.code === 'string'
        const code = hadCode ? (o.code as string) : 'stream-error'
        const hadMessage = o.message !== undefined && o.message !== null
        if (!hadCode && !hadMessage) {
          bareStreamErrors += 1
          this.bareStreamError = bareStreamErrorFault(bareStreamErrors)
          break
        }
        out.push({
          type: 'stream-fault',
          fault: {
            kind: 'response-failed',
            code: `openai-${code}`,
            message: hadMessage ? String(o.message) : 'the provider sent a stream error event with no message',
            retryable: RETRYABLE_OPENAI_CODES.has(code) || !hadCode,
          },
        })
        break
      }
      default:
        break
    }
    return out
  }

  private buildFinish(
    terminal: 'response.completed' | 'response.failed' | 'response.incomplete',
    response: Record<string, unknown> | undefined,
  ): Extract<OpenaiStreamEvent, { type: 'finish' }> {
    let reason: OpenaiFinishReason
    let incompleteDetail: string | undefined
    if (terminal === 'response.incomplete') {
      const details = asRecord(response?.incomplete_details)
      const raw = typeof details?.reason === 'string' ? details.reason : ''
      incompleteDetail = raw === '' ? 'no reason stated' : raw
      reason =
        raw === 'max_output_tokens'
          ? 'max_output_tokens'
          : raw === 'content_filter'
            ? 'content_filter'
            : 'other-incomplete'
    } else {
      reason = this.toolCalls.length > 0 ? 'tool_calls' : 'completed'
    }
    return {
      type: 'finish',
      reason,
      toolCalls: [...this.toolCalls],
      reasoningItems: [...this.reasoningItems],
      orderedItems: [...this.orderedItems],
      finalText: this.textParts.join(''),
      refusalText: this.refusalParts.join(''),
      unknownItemTypes: [...this.unknownItemTypes],
      webSearchCalls: [...this.webSearchCalls],
      citations: [...this.citations],
      ...(incompleteDetail !== undefined ? { incompleteDetail } : {}),
      ...(this.responseId ? { responseId: this.responseId } : {}),
    }
  }

  private addCitation(url: string, title: string): void {
    if (this.citationUrls.has(url)) return
    this.citationUrls.add(url)
    this.citations.push({ url, title })
  }
}
