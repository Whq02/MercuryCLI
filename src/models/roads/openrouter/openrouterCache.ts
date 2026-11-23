import type { CompatChatRequest, CompatMessage, CompatWireMessage } from '../openaicompat/compatChatClient.js'

const QWEN_EXPLICIT = new Set(['qwen/qwen3-max', 'qwen/qwen-plus', 'qwen/qwen3.6-plus', 'qwen/qwen3-coder-plus', 'qwen/qwen3-coder-flash'])
const CONTROL = { type: 'ephemeral' as const }

function hasCacheableText(content: CompatMessage['content']): boolean {
  return typeof content === 'string' ? content !== '' : Array.isArray(content) && content.some(part => part.type === 'text' && part.text !== '')
}

function cacheContent(content: CompatMessage['content'], both: boolean): CompatMessage['content'] {
  if (typeof content === 'string') {
    if (content === '') return content
    const part = { type: 'text' as const, text: content, cache_control: CONTROL }
    return [part]
  }
  if (content === null || content.length === 0) return content
  const textIndices = content.flatMap((part, i) => part.type === 'text' && part.text !== '' ? [i] : [])
  const last = textIndices.at(-1)
  if (last === undefined) return content
  const first = both ? textIndices[0] : last
  return content.map((part, i) => i === first || i === last ? { ...part, cache_control: CONTROL } : part)
}

export function openrouterChatCache(request: CompatChatRequest): CompatChatRequest {
  const anthropic = request.model.startsWith('anthropic/')
  if (!anthropic && !QWEN_EXPLICIT.has(request.model)) return request
  const firstSystem = request.messages.findIndex(message => message.role === 'system' && 'content' in message && hasCacheableText(message.content))
  const tail = request.messages.findLastIndex(message => message.role !== 'system' && 'content' in message && hasCacheableText(message.content))
  const messages: CompatWireMessage[] = request.messages.map((message, i) => {
    if (!('content' in message) || (i !== firstSystem && i !== tail)) return message
    return { ...message, content: cacheContent(message.content, anthropic && i === firstSystem) }
  })
  const tools = anthropic && request.tools?.length ? request.tools.map((tool, i, all) => i === all.length - 1 ? { ...tool, cache_control: CONTROL } : tool) : request.tools
  return { ...request, messages, ...(tools === undefined ? {} : { tools }) }
}

export function openrouterResponsesCache(model: string): { cache_control?: { type: 'ephemeral' } } {
  return model.startsWith('anthropic/') ? { cache_control: CONTROL } : {}
}
