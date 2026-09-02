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
        return typed.type ? `[${typed.type}]` : ''
      })
      .join('')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
}

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
          thinkingTexts.push((block as { thinking: string }).thinking)
        }
      }
      out.push({
        role: 'assistant',
        content: texts.length > 0 ? texts.join('\n') : toolCalls!.length > 0 ? null : '',
        ...(thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join('\n') } : {}),
        ...(toolCalls!.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
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
  malformedToolCalls: ZaiCompletedToolCall[]
  stopReason: ZaiStopReason
  usage?: ZaiUsage
  fault?: ZaiFault
}

const STOP_REASON_MAP: Record<string, ZaiStopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
}

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
        break
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
