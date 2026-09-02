// ============================================================================
//  providers/openai/responsesBridge — the DIRECT Mercury ↔ OpenAI Responses
//  codec. The GPT lane's whole
//  point is that the EXISTING agent loop runs GPT turns: Mercury message
//  params go OUT as Responses input items, and the typed stream folds BACK
//  into the Mercury stream grammar (types/wire.ts) the loop natively
//  consumes. No second loop, no provider-SDK intermediate — a codec over
//  the hand-rolled wire, byte-parallel to the zai sibling (zaiCodec.ts).
//
//  Laws:
//    - request mapping is TOTAL over the message shapes the agent loop
//      actually produces (system string · user text · assistant text ·
//      assistant tool_use · user tool_result); anything unexpected degrades
//      to its text rendering — never a throw mid-turn;
//    - tool schemas ride the SAME zodToJsonSchema product the Anthropic wire
//      uses (one schema truth; the Responses spelling is FLAT function tools);
//    - STATELESS REPLAY (decision #4): a GPT turn that carries its
//      apexProviderTurn record replays that record's ordered items VERBATIM
//      (reasoning items with encrypted content in their true positions);
//      turns without a record (pre-capture sessions, Anthropic/GLM turns in a
//      mixed transcript, interrupted partials) derive items from their
//      content blocks — text + tool_use map, thinking never round-trips
//      cross-provider;
//    - every Mercury tool_use replays as function_call + its user tool_result
//      as function_call_output (call_id correlation is the tool_use id, which
//      IS the provider call id for GPT turns — the runtime settles blocks
//      under the provider's call_… ids);
//    - decode is DEFENSIVE: turn records come from disk (transcripts) — a
//      malformed record is ignored (falls back to content derivation), never
//      a crash, never a half-replay.
// ============================================================================
import type { JsonOutputFormat, MessageParam } from '../../../types/wire.js'
import { toOpenaiStrictSchema } from '../../../utils/messages/structuredOutputDialect.js'
import type { ApiShapedTool } from '../zai/zaiCodec.js'
import type {
  OpenaiFunctionTool,
  OpenaiInputItem,
  OpenaiMessageItem,
  OpenaiWebSearchTool,
} from './openaiWire.js'
import type { OpenaiResponsesRequest } from './openaiWire.js'
import type { NativeWebSearchRequest } from '../../search/nativeSearchRequest.js'
import { flagEnabled } from '../../../substrate/flagRegistry.js'

// ── The persisted turn record (decision #4) ─────────────────────────────────

/** The typed shape behind AssistantMessage.apexProviderTurn (types/message.ts
 *  keeps items `unknown[]` — this owner decodes them defensively). */
export interface OpenaiTurnRecord {
  provider: 'openai'
  responseId?: string
  items: OpenaiInputItem[]
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

/** Decode one stored replay item; undefined for shapes we do not understand
 *  (dropped from replay — the remaining items still replay). */
function decodeReplayItem(raw: unknown): OpenaiInputItem | undefined {
  const o = asRecord(raw)
  if (!o) return undefined
  if (o.type === 'reasoning') {
    const summaryRaw = Array.isArray(o.summary) ? o.summary : []
    const summary: Array<{ type: 'summary_text'; text: string }> = []
    for (const s of summaryRaw) {
      const rec = asRecord(s)
      if (rec?.type === 'summary_text' && typeof rec.text === 'string') {
        summary.push({ type: 'summary_text', text: rec.text })
      }
    }
    return {
      type: 'reasoning',
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
      summary,
      ...(Array.isArray(o.content) ? { content: o.content } : {}),
      ...(typeof o.encrypted_content === 'string'
        ? { encrypted_content: o.encrypted_content }
        : {}),
    }
  }
  if (o.type === 'function_call') {
    if (typeof o.call_id !== 'string' || typeof o.name !== 'string') return undefined
    return {
      type: 'function_call',
      call_id: o.call_id,
      name: o.name,
      arguments: typeof o.arguments === 'string' ? o.arguments : '{}',
      ...(typeof o.id === 'string' ? { id: o.id } : {}),
    }
  }
  if (o.type === 'message' && o.role === 'assistant') {
    const contentRaw = Array.isArray(o.content) ? o.content : []
    const content: OpenaiMessageItem['content'] = []
    for (const part of contentRaw) {
      const rec = asRecord(part)
      if (rec?.type === 'output_text' && typeof rec.text === 'string') {
        content.push({ type: 'output_text', text: rec.text })
      }
    }
    if (content.length === 0) return undefined
    return { type: 'message', role: 'assistant', content }
  }
  return undefined
}

/** Defensive decode of a stored apexProviderTurn value. */
export function decodeOpenaiTurnRecord(raw: unknown): OpenaiTurnRecord | undefined {
  const o = asRecord(raw)
  if (!o || o.provider !== 'openai' || !Array.isArray(o.items)) return undefined
  const items: OpenaiInputItem[] = []
  for (const item of o.items) {
    const decoded = decodeReplayItem(item)
    if (decoded) items.push(decoded)
  }
  if (items.length === 0) return undefined
  return {
    provider: 'openai',
    items,
    ...(typeof o.responseId === 'string' ? { responseId: o.responseId } : {}),
  }
}

// ── Request side ────────────────────────────────────────────────────────────

/** Responses function tools are FLAT — same schema truth, different spelling
 *  from the chat-completions nested form the Z.AI wire uses. */
export function mapToolsToOpenai(tools: readonly ApiShapedTool[]): OpenaiFunctionTool[] {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.input_schema,
  }))
}

/** One bridge-input row: the message-param content the agent loop produces,
 *  plus (for assistant rows) the turn id for grouping and the decoded replay
 *  record when this row carries one. The runtime builds these from the raw
 *  transcript messages. */
export interface BridgeMessage {
  role: 'user' | 'assistant'
  content: MessageParam['content']
  /** message.id — consecutive assistant rows with the same id are ONE turn. */
  turnId?: string
  turnRecord?: OpenaiTurnRecord
}

/** Anthropic image block → the Responses image_url string (data: URI for
 *  base64 sources, the URL itself for url sources); undefined for shapes we
 *  do not understand (degrades to a visible marker, never a silent drop). */
function imageUrlOfBlock(block: unknown): string | undefined {
  const source = (block as { source?: Record<string, unknown> }).source
  if (!source) return undefined
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return `data:${media};base64,${source.data}`
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url
  return undefined
}

/** Tool-result content → the function_call_output body: a plain string when
 *  text-only (byte-stable with the pre-A4 wire), the content-item ARRAY form
 *  when images ride (reference-verified shape). */
function toolResultOutput(
  content: unknown,
  isError: boolean,
  imagesSupported: boolean,
): string | Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }> {
  const prefix = isError ? '[tool error] ' : ''
  if (typeof content === 'string') return `${prefix}${content}`
  if (content === undefined || content === null) return prefix
  if (!Array.isArray(content)) return `${prefix}${JSON.stringify(content)}`
  const texts: string[] = []
  const images: string[] = []
  for (const part of content) {
    const rec = typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : undefined
    if (rec?.type === 'text') texts.push(String(rec.text ?? ''))
    else if (rec?.type === 'image') {
      const url = imagesSupported ? imageUrlOfBlock(rec) : undefined
      if (url) images.push(url)
      else texts.push('[image]')
    }
  }
  const joined = `${prefix}${texts.join('')}`
  if (images.length === 0) return joined
  return [
    { type: 'input_text' as const, text: joined },
    ...images.map(image_url => ({ type: 'input_image' as const, image_url })),
  ]
}

type UserPart = OpenaiMessageItem['content'][number]

function flushUserParts(out: OpenaiInputItem[], parts: UserPart[]): void {
  if (parts.length === 0) return
  out.push({ type: 'message', role: 'user', content: [...parts] })
  parts.length = 0
}

/** Derive one user row's items: text/image parts → ONE ordered user message
 *  item; tool_result → function_call_output (order preserved — outputs
 *  answer the calls the preceding assistant turn replayed). */
function mapUserMessage(
  out: OpenaiInputItem[],
  message: BridgeMessage,
  imagesSupported: boolean,
): void {
  if (typeof message.content === 'string') {
    if (message.content.trim() !== '') {
      out.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: message.content }],
      })
    }
    return
  }
  const parts: UserPart[] = []
  const pushText = (text: string): void => {
    const last = parts.at(-1)
    if (last && last.type === 'input_text') last.text += `\n${text}`
    else parts.push({ type: 'input_text', text })
  }
  for (const block of message.content) {
    if (block.type === 'text') {
      pushText((block as { text: string }).text)
    } else if (block.type === 'image') {
      // A4: user images map to input_image parts in true position; an
      // unsupported modality (or undecodable source) degrades to a VISIBLE
      // marker, never a silent drop.
      const url = imagesSupported ? imageUrlOfBlock(block) : undefined
      if (url) parts.push({ type: 'input_image', image_url: url })
      else pushText('[image]')
    } else if (block.type === 'tool_result') {
      flushUserParts(out, parts)
      const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
      out.push({
        type: 'function_call_output',
        call_id: b.tool_use_id,
        output: toolResultOutput(b.content, b.is_error === true, imagesSupported),
      })
    } else {
      // remaining attachment shapes degrade to a marker (zai precedent).
      pushText(`[${block.type}]`)
    }
  }
  flushUserParts(out, parts)
}

/** Derive one assistant row's items from its content blocks (the no-record
 *  path): text → assistant message items · tool_use → function_call ·
 *  thinking never round-trips cross-provider. */
function mapDerivedAssistantMessage(out: OpenaiInputItem[], message: BridgeMessage): void {
  if (typeof message.content === 'string') {
    if (message.content.trim() !== '') {
      out.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: message.content }],
      })
    }
    return
  }
  const texts: string[] = []
  const flushTexts = (): void => {
    if (texts.length === 0) return
    out.push({
      type: 'message',
      role: 'assistant',
      content: texts.map(text => ({ type: 'output_text' as const, text })),
    })
    texts.length = 0
  }
  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push((block as { text: string }).text)
    } else if (block.type === 'tool_use') {
      flushTexts()
      const b = block as { id: string; name: string; input: unknown }
      out.push({
        type: 'function_call',
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      })
    }
    // thinking / redacted_thinking blocks never round-trip to the provider
  }
  flushTexts()
}

/**
 * Mercury history → Responses input items. Consecutive assistant rows sharing
 * a turnId form ONE turn: when any row of the turn carries a decoded replay
 * record, the record's items replay VERBATIM (reasoning with encrypted
 * content in true positions) and the turn's content blocks are NOT re-derived
 * (one truth per turn, never both); recordless turns derive from blocks.
 */
/** PROOF CENSUS (operation-shaped): reasoning items and bytes the prune
 *  removed from the last mapping — read by
 *  scripts/providers/prove-gpt-reasoning-replay-prune.ts. */
export const replayPruneCensus = { items: 0, bytes: 0 }

export function mapMessagesToOpenaiInput(
  messages: readonly BridgeMessage[],
  opts?: { imagesSupported?: boolean },
): OpenaiInputItem[] {
  const imagesSupported = opts?.imagesSupported !== false
  const out: OpenaiInputItem[] = []
  // FN-020 S3 (opt-in, default OFF — the wire stays byte-identical until the
  // provider contract is verified live): the stateless request replays
  // every settled turn's record verbatim, reasoning included, so the upload
  // grows with every turn. On, the reasoning items of turns BEFORE the last
  // user message are dropped; the current turn (after it) keeps its own —
  // the documented intra-turn requirement. Every other item and position
  // is untouched. Named consequence: dropping the just-settled turn's
  // reasoning rewrites the provider prefix cache from that turn's position
  // once per turn.
  const prunePrior = flagEnabled('MERCURY_GPT_PRUNE_PRIOR_REASONING')
  let lastUserIndex = -1
  if (prunePrior) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUserIndex = i
        break
      }
    }
  }
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    if (message.role === 'user') {
      mapUserMessage(out, message, imagesSupported)
      index += 1
      continue
    }
    // Collect the assistant turn: consecutive assistant rows, same turnId.
    const turn: BridgeMessage[] = [message]
    let next = index + 1
    while (
      next < messages.length &&
      messages[next]!.role === 'assistant' &&
      messages[next]!.turnId !== undefined &&
      messages[next]!.turnId === message.turnId
    ) {
      turn.push(messages[next]!)
      next += 1
    }
    const record = turn.find(row => row.turnRecord)?.turnRecord
    if (record) {
      if (prunePrior && index < lastUserIndex) {
        for (const item of record.items) {
          if (item.type !== 'reasoning') {
            out.push(item)
            continue
          }
          replayPruneCensus.items++
          replayPruneCensus.bytes += Buffer.byteLength(JSON.stringify(item), 'utf8')
        }
      } else {
        out.push(...record.items)
      }
    } else {
      for (const row of turn) mapDerivedAssistantMessage(out, row)
    }
    index = next
  }
  return out
}

// ── Request assembly ────────────────────────────────────────────────────────

export interface BuildOpenaiRequestInput {
  model: string
  instructions?: string
  messages: readonly BridgeMessage[]
  tools?: readonly ApiShapedTool[]
  /** The LIVE-resolved wire effort (resolveGptReasoningProfile) — never the
   *  Anthropic enum, never hardcoded. Undefined omits the effort key (the
   *  model default applies server-side). */
  reasoningEffort?: string
  /** Stable per-thread prefix-cache key. */
  promptCacheKey?: string
  /** Live modality gate (A4): false degrades images to visible markers
   *  instead of input_image items. Default true. */
  imagesSupported?: boolean
  /** Structured-output forcing: the SAME JsonOutputFormat
   *  the Anthropic wire's output_config.format carries, spelled as the
   *  Responses text.format json_schema block. */
  outputFormat?: JsonOutputFormat
  /** The provider-neutral native search request (services/search) — rides
   *  as the hosted web_search tool beside the function tools. */
  nativeWebSearch?: NativeWebSearchRequest
}

/** The hosted web_search tool for a neutral search request: the allow
 *  list rides the wire's documented filter (capped at its 20-entry limit);
 *  blocked domains have no wire spelling here — the search door
 *  post-filters them. */
export function webSearchToolFor(request: NativeWebSearchRequest): OpenaiWebSearchTool {
  const allowed = (request.allowedDomains ?? []).map(d => d.trim()).filter(d => d !== '').slice(0, 20)
  return { type: 'web_search', ...(allowed.length > 0 ? { filters: { allowed_domains: allowed } } : {}) }
}

/** Build the stateless-replay Responses request (store:false + encrypted
 *  reasoning include — the documented native continuation contract). */
export function buildOpenaiResponsesRequest(
  i: BuildOpenaiRequestInput,
): OpenaiResponsesRequest {
  const functionTools = i.tools && i.tools.length > 0 ? mapToolsToOpenai(i.tools) : []
  const hostedTools = i.nativeWebSearch ? [webSearchToolFor(i.nativeWebSearch)] : []
  const composed = [...functionTools, ...hostedTools]
  const tools = composed.length > 0 ? composed : undefined
  return {
    model: i.model,
    ...(i.instructions && i.instructions.trim() !== ''
      ? { instructions: i.instructions }
      : {}),
    input: mapMessagesToOpenaiInput(i.messages, {
      imagesSupported: i.imagesSupported !== false,
    }),
    ...(tools ? { tools, tool_choice: 'auto' as const, parallel_tool_calls: true } : {}),
    reasoning: {
      ...(i.reasoningEffort ? { effort: i.reasoningEffort } : {}),
      summary: 'auto' as const,
    },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    ...(i.promptCacheKey ? { prompt_cache_key: i.promptCacheKey } : {}),
    ...(i.outputFormat
      ? {
          text: {
            format: {
              type: 'json_schema' as const,
              name: 'mercury_structured_output',
              // The Responses validator refuses plain JSON Schema optionality
              // (required must name every key) — the wire wears the vendor's
              // strict dialect; consumers keep the plain spelling.
              schema: toOpenaiStrictSchema(i.outputFormat.schema),
            },
          },
        }
      : {}),
  }
}
