import { providerRefusedImage } from '../../api/mediaRefusal.js'
import { requestTurnOf } from '../../../rows/request.js'
import type { MessageParam } from '../../../types/wire.js'
import type { EffortWireFact } from '../../../utils/effortStamp.js'
import { pdfBlockData } from '../pdfBlock.js'
import type {
  ZaiChatRequest,
  ZaiCompletedToolCall,
  ZaiContentPart,
  ZaiFault,
  ZaiMessage,
  ZaiStreamEvent,
  ZaiTool,
  ZaiToolDeclarationMessage,
  ZaiUsage,
  ZaiWireMessage,
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

export type ToolDeclarationRowBuilder = (tools: readonly ZaiTool[]) => ZaiWireMessage

export function toolDeclarationRowAsTools(tools: readonly ZaiTool[]): ZaiToolDeclarationMessage {
  return { role: 'system', tools: [...tools] }
}

function toolDeclarationText(tools: readonly ZaiTool[]): string {
  return `Additional tools declared for this conversation from this point on, in the same format as your tool list; call them exactly like the tools declared there.\n<tools>\n${tools.map(tool => JSON.stringify(tool)).join('\n')}\n</tools>`
}

export function toolDeclarationRowAsText(tools: readonly ZaiTool[]): ZaiMessage {
  return { role: 'system', content: toolDeclarationText(tools) }
}

export function toolDeclarationRowInResult(tools: readonly ZaiTool[]): ZaiMessage {
  return { role: 'tool', content: toolDeclarationText(tools) }
}

function imageUrlOfBlock(block: unknown): string | undefined {
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
  files?: string[]
}

function partsOfToolResultContent(content: unknown, imagesSupported: boolean, pdfSupported: boolean): ToolResultParts {
  if (typeof content === 'string') return { text: content, images: [] }
  if (Array.isArray(content)) {
    const texts: string[] = []
    const images: string[] = []
    const files: string[] = []
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue
      const typed = part as { type?: string; text?: unknown }
      if (typed.type === 'text') {
        texts.push(String(typed.text ?? ''))
        continue
      }
      const data = pdfSupported ? pdfBlockData(part) : undefined
      const url = typed.type === 'image' && imagesSupported ? imageUrlOfBlock(part) : undefined
      if (data !== undefined) files.push(data)
      else if (url !== undefined) images.push(url)
      else if (typed.type) texts.push(`[${typed.type}]`)
    }
    return { text: texts.join(''), images, files }
  }
  if (content === undefined || content === null) return { text: '', images: [] }
  return { text: JSON.stringify(content), images: [] }
}

function userRowContent(texts: readonly string[], images: readonly string[], files: readonly string[], pdfFormat: 'file' | 'document_url' = 'file'): string | ZaiContentPart[] {
  if (images.length === 0 && files.length === 0) return texts.join('\n')
  const parts: ZaiContentPart[] = []
  if (texts.length > 0) parts.push({ type: 'text', text: texts.join('\n') })
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
  for (const data of files) {
    const url = `data:application/pdf;base64,${data}`
    parts.push(pdfFormat === 'document_url' ? { type: 'document_url', document_url: url } : { type: 'file', file: { filename: 'document.pdf', file_data: url } })
  }
  return parts
}

export function requestCarriesImage(messages: readonly ZaiWireMessage[]): boolean {
  return messages.some(message => 'content' in message && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
}

export { providerRefusedImage }

export function imageRefusalWords(
  request: { messages: readonly ZaiWireMessage[] },
  fault: { code: string; message: string },
): string | null {
  if (!requestCarriesImage(request.messages)) return null
  if (!providerRefusedImage(fault.message)) return null
  return fault.message ? `${fault.code}: ${fault.message}` : fault.code
}

export const ASSISTANT_THINKING_ONLY_ROW = '(thinking)'

function lastUserQueryIndex(messages: readonly MessageParam[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user') continue
    const turn = requestTurnOf(message.role, message.content)
    if (turn.stringContent !== undefined || turn.items.some(item => item.type === 'text')) return index
  }
  return -1
}

export function mapMessagesToZai(
  system: string | undefined,
  messages: readonly MessageParam[],
  opts?: { keepReasoningHistory?: boolean; keepReasoningAfterLastUser?: boolean; imagesSupported?: boolean; pdfSupported?: boolean; pdfFormat?: 'file' | 'document_url'; toolDeclarations?: ReadonlyMap<string, ZaiWireMessage> },
): ZaiWireMessage[] {
  const out: ZaiWireMessage[] = []
  const imagesSupported = opts?.imagesSupported !== false
  const lastQuery = opts?.keepReasoningAfterLastUser === true ? lastUserQueryIndex(messages) : -1
  if (system && system.trim() !== '') out.push({ role: 'system', content: system })
  for (const [index, message] of messages.entries()) {
    const turn = requestTurnOf(message.role, message.content)
    if (turn.stringContent !== undefined) {
      out.push({ role: turn.role, content: turn.stringContent })
      continue
    }
    if (message.role === 'assistant') {
      const texts: string[] = []
      const thinkingTexts: string[] = []
      const toolCalls: ZaiMessage['tool_calls'] = []
      const keepReasoning = opts?.keepReasoningHistory === true || (opts?.keepReasoningAfterLastUser === true && index > lastQuery)
      for (const item of turn.items) {
        if (item.type === 'text') texts.push(item.text)
        else if (item.type === 'tool_call' && item.native === 'tool_use') {
          toolCalls!.push({ id: item.call_id, type: 'function', function: { name: item.tool, arguments: JSON.stringify(item.input ?? {}) } })
        } else if (item.type === 'reasoning' && !item.redacted && keepReasoning) thinkingTexts.push(item.text)
      }
      out.push({
        role: 'assistant',
        content: texts.length > 0 ? texts.join('\n') : toolCalls!.length > 0 ? null : thinkingTexts.length > 0 ? '' : ASSISTANT_THINKING_ONLY_ROW,
        ...(thinkingTexts.length > 0 ? { reasoning_content: thinkingTexts.join('\n') } : {}),
        ...(toolCalls!.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }
    const toolRows: ZaiMessage[] = []
    const declarationRows: ZaiWireMessage[] = []
    const userParts: string[] = []
    const userImages: string[] = []
    const userFiles: string[] = []
    for (const item of turn.items) {
      if (item.type === 'text') userParts.push(item.text)
      else if (item.type === 'tool_result') {
        const parts = partsOfToolResultContent(item.output, imagesSupported, opts?.pdfSupported === true)
        const resultText = (item.value as { is_error?: boolean }).is_error ? `[tool error] ${parts.text}` : parts.text
        const declaration = opts?.toolDeclarations?.get(item.call_id)
        const inResult = declaration !== undefined && 'content' in declaration && declaration.role === 'tool' && typeof declaration.content === 'string' ? declaration.content : undefined
        toolRows.push({ role: 'tool', tool_call_id: item.call_id, content: inResult !== undefined ? `${resultText}\n\n${inResult}` : resultText })
        userImages.push(...parts.images)
        userFiles.push(...(parts.files ?? []))
        if (declaration !== undefined && inResult === undefined) declarationRows.push(declaration)
      } else {
        const data = opts?.pdfSupported ? pdfBlockData(item.value) : undefined
        const url = item.value.type === 'image' && imagesSupported ? imageUrlOfBlock(item.value) : undefined
        if (data !== undefined) userFiles.push(data)
        else if (url !== undefined) userImages.push(url)
        else userParts.push(`[${item.value.type}]`)
      }
    }
    out.push(...toolRows)
    out.push(...declarationRows)
    if (userParts.length > 0 || userImages.length > 0 || userFiles.length > 0) {
      out.push({ role: 'user', content: userRowContent(userParts, userImages, userFiles, opts?.pdfFormat) })
    }
  }
  return out
}

interface BuildZaiRequestInput {
  model: string
  system?: string
  messages: readonly MessageParam[]
  imagesSupported?: boolean
  tools?: readonly ApiShapedTool[]
  toolDeclarations?: ReadonlyMap<string, ZaiWireMessage>
  maxTokens?: number
  reasoningEffort?: string
  thinkingEnabled?: boolean
  requestId?: string
}

export function zaiEffortWireFact(request: ZaiChatRequest, supported: boolean): EffortWireFact {
  const effort = request.reasoning_effort
  if (typeof effort === 'string' && effort !== '') return { kind: 'sent', parameter: 'reasoning_effort', value: effort }
  return supported ? { kind: 'omitted' } : { kind: 'unsupported' }
}

export function buildZaiChatRequest(i: BuildZaiRequestInput): ZaiChatRequest {
  return {
    model: i.model,
    messages: mapMessagesToZai(i.system, i.messages, { imagesSupported: i.imagesSupported, ...(i.toolDeclarations !== undefined ? { toolDeclarations: i.toolDeclarations } : {}) }),
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


type ZaiStopReason = 'end_turn' | 'tool_use' | 'max_tokens'

interface ZaiAssembledToolUse {
  id: string
  name: string
  input: unknown
}

interface ZaiAssembledTurn {
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
