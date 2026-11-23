function isToolResultBlock(item: unknown): boolean {
  return typeof item === 'object' && item !== null && 'type' in item && item.type === 'tool_result'
}

export function insertBlockAfterToolResults(content: unknown[], block: unknown): void {
  let lastToolResultIndex = -1
  for (let i = content.length - 1; i >= 0; i--) {
    if (isToolResultBlock(content[i])) {
      lastToolResultIndex = i
      break
    }
  }
  if (lastToolResultIndex !== -1) {
    const insertIndex = lastToolResultIndex + 1
    if (insertIndex === content.length) {
      content.push(block, { type: 'text', text: '.' })
    } else {
      content.splice(insertIndex, 0, block)
    }
    return
  }
  const insertIndex = content.length === 0 ? 0 : content.length - 1
  content.splice(insertIndex, 0, block)
}
