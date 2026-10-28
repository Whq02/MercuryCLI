import type { Message } from '../../types/message.js'

export function evalNestedToolIds(message: Message): string[] {
  if (message.type !== 'progress') return []
  const data = message.data
  if (data.type !== 'eval_progress' || data.kind !== 'nested' || data.message.type !== 'assistant') return []
  const content = data.message.message.content
  if (!Array.isArray(content)) return []
  return content.flatMap(block => block.type === 'tool_use' ? [block.id] : [])
}
