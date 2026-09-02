// ============================================================================
//  providers/zai/zaiCodec — the DIRECT Mercury ↔ Z.AI codec (
//  made it direct). The Z.AI lane's whole point is that the
//  EXISTING agent loop runs GLM turns: Mercury message params go OUT in
//  Z.AI's native shape, and the typed stream folds BACK into the Mercury
//  stream grammar (types/wire.ts) the loop natively consumes. No second
//  loop, no provider-SDK intermediate — a codec over the hand-rolled wire.
//
//  Laws:
//    - request mapping is TOTAL over the Mercury param shapes the agent loop
//      actually produces (system string · user text · assistant text ·
//      assistant tool_use · user tool_result); anything unexpected degrades
//      to its text rendering — never a throw mid-turn;
//    - tool schemas ride the SAME zodToJsonSchema product every wire uses
//      (one schema truth, per-wire spellings);
//    - assembleZaiTurn folds the typed event stream into ONE settled turn:
//      thinking + text + EXACTLY-ONCE tool_use blocks (id/name/parsed input),
//      stop reason mapped (stop→end_turn · tool_calls→tool_use ·
//      length→max_tokens), usage carried; malformed tool calls and stream
//      faults surface as typed fields — never silent, never partial.
// ============================================================================
import type { MessageParam } from '../../../types/wire.js'
import type {
  ZaiChatRequest,
  ZaiCompletedToolCall,
  ZaiFault,
  ZaiMessage,
  ZaiStreamEvent,
  ZaiTool,
  ZaiUsage,
} from './zaiClient.js'

// ── Request side ────────────────────────────────────────────────────────────

/** The API-shaped tool descriptor (name/description/input_schema) — the same
 *  product utils/api.ts builds for every wire. */
export interface ApiShapedTool {
  name: string
  description?: string
  input_schema: unknown
}

export function mapToolsToZai(tools: readonly ApiShapedTool[]): ZaiTool[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema,
    },
  }))
}

function textOfToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part !== 'object' || part === null) return ''
        const typed = part as { type?: string; text?: unknown }
        if (typed.type === 'text') return String(typed.text ?? '')
        // Non-text result parts (image · document) cannot ride a
        // chat-completions tool message — degrade LOUDLY to the same named
        // placeholder the user-content path uses, never to silence: an
        // empty result after a successful screenshot read strands the
        // model without the reason.
        return typed.type ? `[${typed.type}]` : ''
      })
      .join('')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

/** Mercury history → Z.AI messages. System prompt first; tool_use becomes
 *  assistant.tool_calls; tool_result becomes a role:'tool' message.
 *  keepReasoningHistory returns historical thinking as reasoning_content on
 *  assistant messages — ONLY for lanes whose docs require it (Kimi's
 *  Preserved-Thinking models, platform.kimi.ai use-thinking-models fetched
 * historical reasoning_content kept "as-is", mandatorily);
 *  DeepSeek documents the opposite (returned reasoning rejects) and Z.AI's
 *  standard endpoint preserves only under clear_thinking:false (deferred
 *  live), so omit stays the default. */
export function mapMessagesToZai(
  system: string | undefined,
  messages: readonly MessageParam[],
  opts?: { keepReasoningHistory?: boolean },
): ZaiMessage[] {
  const out: ZaiMessage[] = []
  if (system && system.trim() !== '') out.push({ role: 'system', content: system })
  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      const texts: string[] = []
      const thinkingTexts: string[] = []
      const toolCalls: ZaiMessage['tool_calls'] = []
      for (const block of message.content) {
        if (block.type === 'text') texts.push((block as { text: string }).text)
        else if (block.type === 'tool_use') {
          const b = block as { id: string; name: string; input: unknown }
          toolCalls!.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          })
        } else if (block.type === 'thinking' && opts?.keepReasoningHistory === true) {
          // Preserved-thinking lanes return the historical reasoning
          // verbatim; every other lane keeps thinking OFF the wire.
          thinkingTexts.push((block as { thinking: string }).thinking)
        }
      }
      // `content: null` is the documented shape ONLY beside tool_calls; an
      // assistant turn with neither text nor calls (a thinking-only turn on
      // a lane that keeps reasoning off the wire) replays as empty text —
      // strict servers reject null content on a call-less message.
      out.push({
        role: 'assistant',
        content: texts.length > 0 ? texts.join('\n') : toolCalls!.length > 0 ? null : '',
        ...(thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join('\n') } : {}),
        ...(toolCalls!.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    // user role: every tool result of the row FIRST — a `tool` row must
    // directly follow the assistant tool_calls row or another `tool` row,
    // and a user row between them is a 400 on strict servers — then the
    // row's text and non-text parts pooled into ONE user row, in their own
    // order (feedback beside a result reads after the round it annotates).
    const toolRows: ZaiMessage[] = []
    const userParts: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') userParts.push((block as { text: string }).text)
      else if (block.type === 'tool_result') {
        const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
        const text = textOfToolResultContent(b.content)
        toolRows.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `[tool error] ${text}` : text,
        })
      } else {
        userParts.push(`[${block.type}]`)
      }
    }
    out.push(...toolRows)
    if (userParts.length > 0) out.push({ role: 'user', content: userParts.join('\n') })
  }
  return out
}

export interface BuildZaiRequestInput {
  model: string
  system?: string
  messages: readonly MessageParam[]
  tools?: readonly ApiShapedTool[]
  maxTokens?: number
  reasoningEffort?: string
  thinkingEnabled?: boolean
  requestId?: string
}

export function buildZaiChatRequest(i: BuildZaiRequestInput): ZaiChatRequest {
  return {
    model: i.model,
    messages: mapMessagesToZai(i.system, i.messages),
    ...(i.tools && i.tools.length > 0
      ? { tools: mapToolsToZai(i.tools), tool_choice: 'auto' as const }
      : {}),
    ...(i.maxTokens !== undefined ? { max_tokens: i.maxTokens } : {}),
    ...(i.reasoningEffort !== undefined ? { reasoning_effort: i.reasoningEffort } : {}),
    ...(i.thinkingEnabled !== undefined
      ? { thinking: { type: i.thinkingEnabled ? ('enabled' as const) : ('disabled' as const) } }
      : {}),
    ...(i.requestId !== undefined ? { request_id: i.requestId } : {}),
  }
}

// ── Response side ───────────────────────────────────────────────────────────

export type ZaiStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

export interface ZaiAssembledToolUse {
  id: string
  name: string
  input: unknown
}

export interface ZaiAssembledTurn {
  thinking: string
  text: string
  toolUses: ZaiAssembledToolUse[]
  /** Calls whose id/name/arguments never became executable — surfaced, never
   *  silently dropped or half-executed. */
  malformedToolCalls: ZaiCompletedToolCall[]
  stopReason: ZaiStopReason
  usage?: ZaiUsage
  /** The first fault observed (a faulted turn still reports what arrived). */
  fault?: ZaiFault
}

const STOP_REASON_MAP: Record<string, ZaiStopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
}

/** Fold a typed Z.AI event stream into one settled turn. Deterministic, pure
 *  over the event sequence; consumes the whole stream. */
export async function assembleZaiTurn(
  events: AsyncIterable<ZaiStreamEvent>,
  taps?: {
    onReasoningDelta?: (text: string) => void
    onTextDelta?: (text: string) => void
  },
): Promise<ZaiAssembledTurn> {
  let thinking = ''
  let text = ''
  let usage: ZaiUsage | undefined
  let fault: ZaiFault | undefined
  let stopReason: ZaiStopReason = 'end_turn'
  let completed: ZaiCompletedToolCall[] = []

  for await (const event of events) {
    switch (event.type) {
      case 'reasoning-delta':
        thinking += event.text
        taps?.onReasoningDelta?.(event.text)
        break
      case 'text-delta':
        text += event.text
        taps?.onTextDelta?.(event.text)
        break
      case 'usage':
        usage = event.usage
        break
      case 'finish':
        completed = event.toolCalls
        stopReason = STOP_REASON_MAP[event.reason] ?? 'end_turn'
        break
      case 'stream-fault':
        fault = fault ?? event.fault
        break
      case 'tool-call-fragment':
        break // accumulation lives in the client; the finish event settles it
    }
  }

  const toolUses: ZaiAssembledToolUse[] = []
  const malformed: ZaiCompletedToolCall[] = []
  for (const call of completed) {
    if (call.malformed) malformed.push(call)
    else toolUses.push({ id: call.id, name: call.name, input: call.arguments })
  }
  if (toolUses.length > 0 && stopReason === 'end_turn') stopReason = 'tool_use'

  return {
    thinking,
    text,
    toolUses,
    malformedToolCalls: malformed,
    stopReason,
    ...(usage ? { usage } : {}),
    ...(fault ? { fault } : {}),
  }
}
