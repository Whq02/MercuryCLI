// ============================================================================
//  providers/openai/openaiWire — the typed native OpenAI Responses wire
// Pure protocol layer: request/item shapes, the SSE event
//  fold, and the documented error mapping. NO transport, NO account logic —
//  openaiClient.ts owns HTTP; this file is deterministic and fixture-proved.
//
//  Grounded in the provider's published docs:
//  the Responses API SSE vocabulary (response.created /
//  output_item.added|done / content_part.* / output_text.delta|done /
//  refusal.* / function_call_arguments.delta|done / reasoning_summary_* /
//  completed|failed|incomplete, every event carrying sequence_number), the
//  request shape {model, instructions, input, tools, tool_choice,
//  parallel_tool_calls, reasoning{effort,summary}, store, stream, include,
//  prompt_cache_key, text{verbosity}}, and the CURRENT native continuation
//  contract: STATELESS REPLAY — store:false, include
//  ["reasoning.encrypted_content"], reasoning items replayed in order before
//  their function calls; previous_response_id is NOT the contract (server
//  storage is not guaranteed on the subscription route).
//
//  Laws (the zai lane's, held here too):
//    - typed events out, faults as data — the fold never throws for provider
//      trouble;
//    - tool calls settle EXACTLY ONCE from the DONE item (arguments deltas
//      stream live for VISIBILITY — 3.5.1 — and double as the
//      fallback carrier, but never settle a call); a done function_call whose
//      arguments fail JSON.parse is a typed malformed call, never a silent
//      half-call;
//    - unknown event types and unknown output-item types are RECORDED
//      (unknown-item notes), never silently dropped and never a crash — the
//      qualification owner turns systematic unknowns into honest failures;
//    - a stream that ends without response.completed/failed/incomplete is a
//      typed truncation fault.
// ============================================================================

import { logForDebugging } from '../../../utils/debug.js'
import type { StreamCapabilityAdvertisement } from '../../../types/wire.js'

// ── Request shapes (the documented wire) ────────────────────────────────────

/** Responses function tools are FLAT (name at the top level) — unlike the
 *  chat-completions nested `function:{}` spelling the Z.AI wire uses. */
export interface OpenaiFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: unknown
  strict?: boolean
}

/** The hosted web-search tool — the Responses wire's OWN search construct
 *  (the search door's native door for an openai session): the model runs
 *  searches server-side inside the one response; each search settles as a
 *  web_search_call output item and the hits arrive as url_citation
 *  annotations on the answer text. `filters.allowed_domains` is the wire's
 *  documented allow list (at most 20 entries); the wire has no block list —
 *  the search door post-filters. */
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
    // A4: user images ride as input_image data/URL parts (reference-verified
    // wire shape; live models advertise input_modalities ['text','image']).
    | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }
  >
}

export interface OpenaiFunctionCallItem {
  type: 'function_call'
  /** The correlation id tool outputs answer to (call_…). */
  call_id: string
  name: string
  /** JSON-encoded arguments string. */
  arguments: string
  /** The item id (fc_…) when the server minted one. */
  id?: string
}

/** function_call_output content items (the reference wire's array form —
 *  used when a tool result carries images; plain-text results stay strings). */
export type OpenaiFunctionCallOutputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }

export interface OpenaiFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string | OpenaiFunctionCallOutputPart[]
}

/** Reasoning item — replayed with encrypted_content for stateless
 *  continuation (the current native contract). Live shape: the
 *  subscription route emits `content: []` beside summary/encrypted_content —
 *  preserved verbatim so replay stays faithful. */
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
  /** Effort values come from the LIVE per-model catalogue — never hardcoded. */
  reasoning?: { effort?: string; summary?: 'auto' | 'concise' | 'detailed' }
  /** Stateless-replay law: false. */
  store: boolean
  stream: true
  include?: string[]
  /** Stable per-thread cache key — the prefix-caching efficiency mechanism. */
  prompt_cache_key?: string
  text?: {
    /** 3.5.8: typed but NEVER SET by any builder — answer
     *  verbosity is a separate control from reasoning effort, and Mercury
     *  sends no verbosity signal until the provider-contract capture proves
     *  the field's semantics on this route (the EF-04 no-blind-send law).
     *  The concise response profile rides the PROMPT contract instead. */
    verbosity?: 'low' | 'medium' | 'high'
    /** Structured-output forcing: the documented Responses
     *  json_schema format block. */
    format?: {
      type: 'json_schema'
      name: string
      schema: { [key: string]: unknown }
      strict?: boolean
    }
  }
  // NO max_output_tokens: live-proved — the subscription route
  // 400s 'Unsupported parameter'; the reference request carries none either.
}

// ── Typed stream events (the fold's output) ─────────────────────────────────

export interface OpenaiUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}

export interface OpenaiCompletedToolCall {
  callId: string
  itemId?: string
  name: string
  /** Raw accumulated arguments string (always preserved). */
  argumentsRaw: string
  /** Parsed arguments when they form valid JSON. */
  arguments?: unknown
  malformed: boolean
}

export type OpenaiFinishReason = 'completed' | 'tool_calls' | 'max_output_tokens' | 'content_filter' | 'other-incomplete'

export interface OpenaiFault {
  kind:
    | 'http-error'
    | 'api-error'
    | 'response-failed' // response.failed / error event on the stream
    | 'truncated-stream'
    | 'timeout'
    | 'cancelled'
    | 'transport-error'
    | 'usage-limit'
  /** Stable, code-first detail (e.g. 'http-401', 'openai-rate_limit_exceeded',
   *  'no-terminal-event'). NEVER carries a token/key. */
  code: string
  message: string
  retryable: boolean
  /** the STRUCTURED reset fact when the provider stated one —
   *  epoch ms; the prose keeps its human copy, consumers read this field. */
  resetsAtMs?: number
  /** The HTTP status when the fault came from a response — the typed error
   *  classifier reads the status class first, the code word second. */
  status?: number
}

export type OpenaiStreamEvent =
  | { type: 'response-id'; id: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'refusal-delta'; text: string }
  /** 3.5.1: a function_call item opened — its stable identity (item id,
   *  provider call id, tool name) precedes the argument byte stream. */
  | { type: 'tool-args-start'; itemId: string; callId: string; name: string }
  /** 3.5.1: one argument-byte delta for an identified open call —
   *  forwarded verbatim by the same fold() call that ingested it. */
  | { type: 'tool-args-delta'; itemId: string; delta: string }
  /** 3.5.1: the call's arguments settled at its done item (
   *  delta-fallback applied). argsRaw carries the settled raw string so a
   *  stream that never sent deltas paints its bytes exactly once at close. */
  | { type: 'tool-args-done'; itemId: string; argsRaw: string }
  | { type: 'usage'; usage: OpenaiUsage }
  /** A hosted web_search_call item settled (its query when the item
   *  carried one) — progress for the search leg. */
  | { type: 'web-search-call'; id: string; query?: string }
  | {
      type: 'finish'
      reason: OpenaiFinishReason
      toolCalls: OpenaiCompletedToolCall[]
      /** Hosted web-search calls the response ran (web_search_call items),
       *  in arrival order — the search leg reads them; the main loop never
       *  advertises the tool. Not replay items: the leg is a one-shot. */
      webSearchCalls: Array<{ id: string; query?: string }>
      /** url_citation annotations settled from the answer text (the done
       *  message item's parts, or the streamed annotation events),
       *  deduplicated by url — the hits of a hosted search. */
      citations: Array<{ url: string; title: string }>
      /** Settled reasoning items (summary + encrypted_content) in arrival
       *  order — persisted by the runtime for stateless replay. */
      reasoningItems: OpenaiReasoningItem[]
      /** The FULL settled output-item sequence in exact arrival order —
       *  reasoning (with encrypted content) · well-formed function calls ·
       *  assistant message items — the stateless-replay record (decision #4).
       *  Malformed function calls are EXCLUDED (Mercury never executes them,
       *  so replaying an unanswered call would break the call/output pairing). */
      orderedItems: OpenaiInputItem[]
      /** Assistant text settled from output_item.done message items. */
      finalText: string
      /** Refusal text when the model refused (settled, not a fault). */
      refusalText: string
      /** Output-item types the fold did not understand — honesty channel. */
      unknownItemTypes: string[]
      /** The provider's RAW incomplete_details.reason when the terminal was
       *  response.incomplete — carried verbatim so the 'other-incomplete'
       *  class can be surfaced with the provider's own words instead of a
       *  silent end_turn (the dead-turn incident's silent-stop shape). */
      incompleteDetail?: string
      responseId?: string
    }
  | { type: 'stream-fault'; fault: OpenaiFault }

/** (3.5.1): the openai codec's honest capability advertisement — every
 *  true claim is backed by a fold path in THIS file (toolArgsDelta by the
 *  live carriers; usage by parseUsage at the terminal events). Consumers
 *  choose native streaming display vs waiting state from this, not from
 *  guesswork. */
export const OPENAI_STREAM_ADVERTISEMENT: StreamCapabilityAdvertisement = {
  textDelta: true,
  reasoningDelta: true,
  toolArgsDelta: true,
  usage: true,
  timing: true,
}

// ── Error mapping ───────────────────────────────────────────────────────────

/** Documented/observed retryable API error codes (429-family + 5xx ride the
 *  status check; these are body-level `error.code` values). */
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
    // Plan usage windows and rate limits both arrive as 429; 'usage-limit'
    // is the honest kind either way (never silently reroute to another
    // source). Reset facts append when the response names them — live-proved
    // the subscription route carries `resets_in_seconds` +
    // `plan_type` in the body and x-codex-primary-reset-after-seconds in
    // headers (a Plus weekly window read 328224s ≈ 3.8 days).
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
        // Numeric relative-seconds headers become the structured fact too.
        const seconds = Number(value)
        if (resetsAtMs === undefined && Number.isFinite(seconds) && seconds > 0) {
          resetsAtMs = Date.now() + seconds * 1000
        }
      }
    }
    return {
      kind: 'usage-limit',
      // Live 429 bodies carry `type: 'usage_limit_reached'` (no `code` key).
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

// ── The SSE payload fold ────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

/** Drop TOP-LEVEL null-valued keys from a decoded tool-args object.
 *
 *  THE NULL-OPTIONAL LAW (field class — a win32 GPT session
 *  erroring on EVERY file mutation): OpenAI models routinely serialize
 *  optional schema fields as `"param": null` instead of omitting them. Our
 *  tool contracts speak Anthropic conventions — zod `.optional()` accepts
 *  only ABSENT (rejects null with a type error ⇒ the generic "Error editing
 *  file" card), and presence checks like `input.plan_id !== undefined`
 *  count null as PRESENT (⇒ ChangeSet's "EXACTLY ONE" refusal on every
 *  fast-path apply). Stripping nulls restores the omitted-optional meaning
 *  for the whole catalog; a null for a REQUIRED param still fails its own
 *  required check downstream — nothing is lost. Top-level only: nested
 *  nulls can be meaningful payload (file contents, JSON documents) and are
 *  never presence-checked by our validators. The transport gate
 *  (../toolCallGate.ts) applies the same law to every chat-completions
 *  family before schema validation — one owner, every dialect. */
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
    ...(typeof outputDetails?.reasoning_tokens === 'number'
      ? { reasoningOutputTokens: outputDetails.reasoning_tokens }
      : {}),
  }
}

/**
 * Stateful fold over Responses SSE payloads → typed events. One instance per
 * request. Terminal truth: exactly one of completed/failed/incomplete settles
 * the fold; `finished` tells the client whether a terminal event arrived.
 */
export class ResponsesStreamFold {
  finished = false
  private responseId: string | undefined
  private toolCalls: OpenaiCompletedToolCall[] = []
  /** .5: accumulated function_call_arguments deltas per
   *  item id — the fallback when a done item arrives ARGUMENT-LESS (the
   *  field's silent-empty class: arguments {} with malformed:false). A done
   *  item carrying its own non-empty arguments always wins (spec trust).
   *  Bounded by the response's own output budget — never an artificial cap
   *  that could truncate (= corrupt) arguments. */
  private argDeltas = new Map<string, string>()
  /** 3.5.1: function_call item identity recorded at output_item.added
   *  so argument deltas stream with a stable call id + tool name. Items the
   *  provider never identified stay accumulate-only (spec-tolerant) and
   *  paint at settlement instead. */
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
  /** output_text chars already emitted as text-delta events — the
   *  done-carry ledger: a message item whose text was never (fully)
   *  streamed emits the remainder at its done event, exactly once (the
   *  tool-args done-carry law, held for text: a done-only response
   *  otherwise settles an EMPTY turn — the model looks like it silently
   *  stopped, the dead-turn class). */
  private streamedTextChars = 0
  /** output_text chars settled by message done items so far (items settle
   *  in stream order, so the cumulative split attributes streamed chars to
   *  the earliest unsettled item). */
  private settledTextChars = 0

  /** Fold one parsed SSE JSON payload into 0..n typed events. */
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
        // 3.5.1: a function_call item announces its identity here —
        // record it and open the live tool stream. Other item kinds stay
        // progress-only (the done items settle their state).
        const item = asRecord(o.item)
        if (item?.type === 'function_call') {
          const itemId = typeof item.id === 'string' ? item.id : ''
          const callId = typeof item.call_id === 'string' ? item.call_id : ''
          const name = typeof item.name === 'string' ? item.name : ''
          if (itemId && callId && name) {
            this.toolIdentity.set(itemId, { callId, name })
            out.push({ type: 'tool-args-start', itemId, callId, name })
          }
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        // keep the deltas — they are the arguments' only carrier when
        // the done item arrives without them. 3.5.1: an identified
        // item's delta ALSO forwards immediately — the live-visibility
        // carrier (the field's 328s silent-Write class).
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
          // an argument-less done item falls back to the joined
          // deltas; a done item with its own arguments wins.
          const itemId = typeof item.id === 'string' ? item.id : ''
          const doneArgs = typeof item.arguments === 'string' ? item.arguments.trim() : ''
          if (doneArgs === '' && itemId && this.argDeltas.has(itemId)) {
            item.arguments = this.argDeltas.get(itemId)!
          }
          if (itemId) this.argDeltas.delete(itemId)
          const call = parseToolCall(item)
          this.toolCalls.push(call)
          // 3.5.1: close the live tool stream for identified items
          // — argsRaw is the settled raw string (post-fallback), so a stream
          // that carried no deltas paints its bytes exactly once at close.
          if (itemId && this.toolIdentity.has(itemId)) {
            this.toolIdentity.delete(itemId)
            out.push({ type: 'tool-args-done', itemId, argsRaw: call.argumentsRaw })
          }
          if (!call.malformed) {
            // Replay record: the call verbatim (raw arguments string) — an
            // answered call; malformed calls are excluded by law (header).
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
          // Final text/refusal settle from the message item's content parts —
          // the delta stream already painted them live.
          const content = Array.isArray(item.content) ? item.content : []
          const itemTexts: string[] = []
          for (const part of content) {
            const rec = asRecord(part)
            if (rec?.type === 'output_text' && typeof rec.text === 'string') {
              this.textParts.push(rec.text)
              itemTexts.push(rec.text)
              // The done item's annotations are the authoritative citation
              // list (the streamed annotation events are the same facts
              // earlier; dedup by url keeps one hit per source).
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
          // The done-carry: text this item carries that never streamed as
          // deltas paints NOW, exactly once (a done-only response settled
          // an EMPTY turn before this — live-found on a delta-less
          // Responses fixture; the tool-args path already held this law).
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
          if (itemTexts.length > 0) {
            this.orderedItems.push({
              type: 'message',
              role: 'assistant',
              content: itemTexts.map(text => ({ type: 'output_text' as const, text })),
            })
          }
        } else if (itemType === 'web_search_call') {
          // A hosted search settled — recorded for the search leg (its
          // query rides action.query when the provider states one). Not a
          // replay item: the hits live in the message's citations.
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
        // Top-level stream error event (documented): settles as a fault; a
        // terminal response.* event may still follow.
        // incident: (1) the RAW event is logged before the
        // reduction — it would otherwise be read for two fields and destroyed;
        // (2) "the provider sent nothing readable" is stated as itself,
        // never presented as provider data; (3) a bodyless transport error
        // is BOUNDED-RETRYABLE — non-retryable-because-the-provider-omitted
        // -a-code was the unclassifiable-falls-into-the-worst-branch class.
        try {
          logForDebugging(`[openai-wire] raw stream error event: ${JSON.stringify(o)}`)
        } catch {
          logForDebugging('[openai-wire] raw stream error event: <unserializable>')
        }
        const hadCode = typeof o.code === 'string'
        const code = hadCode ? (o.code as string) : 'stream-error'
        const hadMessage = o.message !== undefined && o.message !== null
        out.push({
          type: 'stream-fault',
          fault: {
            kind: 'response-failed',
            code: `openai-${code}`,
            message: hadMessage
              ? String(o.message)
              : 'the provider sent a stream error event with no code or message',
            retryable: RETRYABLE_OPENAI_CODES.has(code) || !hadCode,
          },
        })
        break
      }
      default:
        // Progress-only events (in_progress, content_part.*, *.done text
        // finalizers, reasoning_summary_part.*) carry no state the fold needs
        // beyond what the done items settle — deliberately ignored,
        // spec-tolerantly. (output_item.added and the function_call argument
        // deltas graduated to live carriers at 3.5.1.)
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
