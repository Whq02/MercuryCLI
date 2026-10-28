import type { Message } from '../../types/message.js'

export function fitToolResultImages<M extends Message>(messages: M[], fits: (rows: M[]) => boolean): { messages: M[]; removed: number } {
  let projected = messages
  let removed = 0
  if (fits(projected)) return { messages, removed }
  for (let rowIndex = 0; rowIndex < messages.length; rowIndex++) {
    const row = messages[rowIndex]
    if (row?.type !== 'user' || !Array.isArray(row.message.content)) continue
    for (let blockIndex = 0; blockIndex < row.message.content.length; blockIndex++) {
      const block = row.message.content[blockIndex]
      if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue
      const content = [...block.content]
      for (let partIndex = 0; partIndex < content.length; partIndex++) {
        if (content[partIndex]?.type !== 'image') continue
        content.splice(partIndex--, 1)
        const current = projected[rowIndex]
        if (current?.type !== 'user' || !Array.isArray(current.message.content)) continue
        const blocks = [...current.message.content]
        blocks[blockIndex] = { ...block, content: [...content] }
        projected = [...projected]
        projected[rowIndex] = { ...current, message: { ...current.message, content: blocks } }
        removed++
        if (fits(projected)) return { messages: projected, removed }
      }
    }
  }
  return { messages: projected, removed }
}
