import type { MessageParam } from '../../../types/wire.js'
import type {
  ZaiChatRequest,
  ZaiCompletedToolCall,
  ZaiContentPart,
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

export function imageUrlOfBlock(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const source = (block as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const typed = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown }
  if (typed.type === 'base64' && typeof typed.data === 'string') {
    const media = typeof typed.media_type === 'string' ? typed.media_type : 'image/png'
    return `data:${media};base64,${typed.data}`
  }
  if (typed.type === 'url' && typeof typed.url === 'string') return typed.url
  return undefined
}

interface ToolResultParts {
  text: string
  images: string[]
}

function partsOfToolResultContent(content: unknown, imagesSupported: boolean): ToolResultParts {
  if (typeof content === 'string') return { text: content, images: [] }
  if (Array.isArray(content)) {
    const texts: string[] = []
    const images: string[] = []
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const typed = part as { type?: string; text?: unknown }
      if (typed.type === 'text') {
        texts.push(String(typed.text ?? ''))
        continue
      }
      const url = typed.type === 'image' && imagesSupported ? imageUrlOfBlock(part) : undefined
      if (url !== undefined) images.push(url)
      else if (typed.type) texts.push(`[${typed.type}]`)
    }
    return { text: texts.join(''), images }
  }
  if (content === undefined || content === null) return { text: '', images: [] }
  return { text: JSON.stringify(content), images: [] }
}

function userRowContent(texts: readonly string[], images: readonly string[]): string | ZaiContentPart[] {
  if (images.length === 0) return texts.join('\n')
  const parts: ZaiContentPart[] = []
  if (texts.length > 0) parts.push({ type: 'text', text: texts.join('\n') })
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
  return parts
}

export function requestCarriesImage(messages: readonly ZaiMessage[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
}

const IMAGE_REFUSAL_NEEDLE = /\b(images?|image_url|vision|multimodal|modalit(?:y|ies))\b/i

export function providerRefusedImage(faultMessage: string): boolean {
  return IMAGE_REFUSAL_NEEDLE.test(faultMessage)
}

export function imageRefusalWords(
  request: { messages: readonly ZaiMessage[] },
  fault: { code: string; message: string },
): string | null {
  if (!requestCarriesImage(request.messages)) return null
  if (!providerRefusedImage(fault.message)) return null
  return fault.message ? `${fault.code}: ${fault.message}` : fault.code
}

export function mapMessagesToZai(
  system: string | undefined,
  messages: readonly MessageParam[],
  opts?: { keepReasoningHistory?: boolean; imagesSupported?: boolean },
): ZaiMessage[] {
  const out: ZaiMessage[] = []
  const imagesSupported = opts?.imagesSupported !== false
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
    const userImages: string[] = []
    for (const block of message.content) {
      if (block.type === 'text') userParts.push((block as { text: string }).text)
      else if (block.type === 'tool_result') {
        const b = block as { tool_use_id: string; content?: unknown; is_error?: boolean }
        const parts = partsOfToolResultContent(b.content, imagesSupported)
        toolRows.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `[tool error] ${parts.text}` : parts.text,
        })
        userImages.push(...parts.images)
      } else {
        const url = block.type === 'image' && imagesSupported ? imageUrlOfBlock(block) : undefined
        if (url !== undefined) userImages.push(url)
        else userParts.push(`[${block.type}]`)
      }
    }
    out.push(...toolRows)
    if (userParts.length > 0 || userImages.length > 0) {
      out.push({ role: 'user', content: userRowContent(userParts, userImages) })
    }
  }
  return out
}

export interface BuildZaiRequestInput {
  model: string
  system?: string
  messages: readonly MessageParam[]
  imagesSupported?: boolean
  tools?: readonly ApiShapedTool[]
  maxTokens?: number
  reasoningEffort?: string
  thinkingEnabled?: boolean
  requestId?: string
}

export function buildZaiChatRequest(i: BuildZaiRequestInput): ZaiChatRequest {
  return {
    model: i.model,
    messages: mapMessagesToZai(i.system, i.messages, { imagesSupported: i.imagesSupported }),
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
