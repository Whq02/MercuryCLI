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


export interface OpenaiTurnRecord {
  provider: 'openai'
  responseId?: string
  items: OpenaiInputItem[]
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

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


export function mapToolsToOpenai(tools: readonly ApiShapedTool[]): OpenaiFunctionTool[] {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.input_schema,
  }))
}

export interface BridgeMessage {
  role: 'user' | 'assistant'
  content: MessageParam['content']
  turnId?: string
  turnRecord?: OpenaiTurnRecord
}

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
      pushText(`[${block.type}]`)
    }
  }
  flushUserParts(out, parts)
}

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
  }
  flushTexts()
}

export const replayPruneCensus = { items: 0, bytes: 0 }

export function mapMessagesToOpenaiInput(
  messages: readonly BridgeMessage[],
  opts?: { imagesSupported?: boolean },
): OpenaiInputItem[] {
  const imagesSupported = opts?.imagesSupported !== false
  const out: OpenaiInputItem[] = []
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


export interface BuildOpenaiRequestInput {
  model: string
  instructions?: string
  messages: readonly BridgeMessage[]
  tools?: readonly ApiShapedTool[]
  reasoningEffort?: string
  promptCacheKey?: string
  imagesSupported?: boolean
  outputFormat?: JsonOutputFormat
  nativeWebSearch?: NativeWebSearchRequest
}

export function webSearchToolFor(request: NativeWebSearchRequest): OpenaiWebSearchTool {
  const allowed = (request.allowedDomains ?? []).map(d => d.trim()).filter(d => d !== '').slice(0, 20)
  return { type: 'web_search', ...(allowed.length > 0 ? { filters: { allowed_domains: allowed } } : {}) }
}

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
              schema: toOpenaiStrictSchema(i.outputFormat.schema),
            },
          },
        }
      : {}),
  }
}
