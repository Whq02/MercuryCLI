function isToolResultBlock(item: unknown): boolean {
  return typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'tool_result'
}

export function insertBlockAfterToolResults(content: unknown[], block: unknown): void {
  let index = 0
  while (index < content.length && isToolResultBlock(content[index])) {
    index++
  }
  content.splice(index, 0, block)
}
