import type { ContentBlock, ContentBlockParam } from '../types/wire.js'
import type { ReasoningRow, TextRow, ToolCallRow, ToolResultRow } from './vocabulary.js'

export type StoredBlock = ContentBlock | ContentBlockParam
export type ContentItem =
  | (Pick<TextRow, 'type' | 'text' | 'phase'> & { value: StoredBlock })
  | (Pick<ReasoningRow, 'type' | 'text' | 'redacted'> & { signature?: string; value: StoredBlock })
  | (Pick<ToolCallRow, 'type' | 'call_id' | 'tool'> & { input: unknown; native: string; value: StoredBlock })
  | (Pick<ToolResultRow, 'type' | 'call_id' | 'status'> & { output: unknown; value: StoredBlock })
  | { type: 'media' | 'opaque'; value: StoredBlock }

export function storedBlocksOf(content: unknown): StoredBlock[] {
  if (Array.isArray(content)) return content as StoredBlock[]
  if (typeof content === 'string') return [{ type: 'text', text: content, citations: [] }]
  return []
}

export function contentItemOf(value: StoredBlock): ContentItem {
  switch (value.type) {
    case 'text':
      return { type: 'text', text: value.text, ...('phase' in value ? { phase: value.phase } : {}), value }
    case 'thinking':
      return { type: 'reasoning', text: value.thinking, signature: value.signature, value }
    case 'redacted_thinking':
      return { type: 'reasoning', text: '', redacted: true, value }
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      return { type: 'tool_call', call_id: value.id, tool: value.name, input: value.input, native: value.type, value }
    case 'tool_result':
      return { type: 'tool_result', call_id: value.tool_use_id, status: value.is_error ? 'error' : 'ok', output: value.content, value }
    case 'image':
    case 'document':
      return { type: 'media', value }
    default:
      return { type: 'opaque', value }
  }
}

export function contentItemsOf(content: unknown): ContentItem[] {
  return storedBlocksOf(content).map(contentItemOf)
}

export function clientCallItemsOf(content: unknown): Array<Extract<ContentItem, { type: 'tool_call' }>> {
  return contentItemsOf(content).filter((item): item is Extract<ContentItem, { type: 'tool_call' }> => item.type === 'tool_call' && item.native === 'tool_use')
}

export function resultItemsOf(content: unknown): Array<Extract<ContentItem, { type: 'tool_result' }>> {
  return contentItemsOf(content).filter((item): item is Extract<ContentItem, { type: 'tool_result' }> => item.type === 'tool_result')
}

export function isReasoningContent(value: StoredBlock): boolean {
  return contentItemOf(value).type === 'reasoning'
}

export function joinContentAtTextSeam(a: StoredBlock[], b: StoredBlock[]): StoredBlock[] {
  const left = a.at(-1)
  const right = b[0]
  if (left?.type === 'text' && right?.type === 'text') {
    return [...a.slice(0, -1), { ...left, text: left.text + '\n' }, ...b]
  }
  return [...a, ...b]
}

export function resultsFirst(content: StoredBlock[]): StoredBlock[] {
  const results: StoredBlock[] = []
  const rest: StoredBlock[] = []
  for (const block of content) (contentItemOf(block).type === 'tool_result' ? results : rest).push(block)
  return [...results, ...rest]
}

export function hasTextContent(content: unknown): boolean {
  return storedBlocksOf(content).some(value => {
    const block = value as { type?: unknown; text?: unknown } | null
    return block?.type === 'text' && typeof block.text === 'string' && block.text !== ''
  })
}