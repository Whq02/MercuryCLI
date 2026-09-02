export function insertBlockAfterToolResults(content: unknown[], block: unknown): void {
  let lastToolResultIndex = -1
  for (let i = 0; i < content.length; i++) {
    const candidate = content[i]
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { type?: unknown }).type === 'tool_result'
    ) {
      lastToolResultIndex = i
    }
  }
  if (lastToolResultIndex !== -1) {
    content.splice(lastToolResultIndex + 1, 0, block)
    if (lastToolResultIndex + 1 === content.length - 1) {
      content.push({ type: 'text', text: '.' })
    }
    return
  }
  const insertIndex = Math.max(0, content.length - 1)
  content.splice(insertIndex, 0, block)
}
