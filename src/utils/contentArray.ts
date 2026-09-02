/**
 * Position a supplementary content block inside a message content array
 * relative to its tool-result blocks. The array is mutated in place.
 */
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
      // The inserted block became the final element. A provider may reject a
      // request whose final content block is not text (and equally a text
      // block that is empty), so append a minimal text continuation. The
      // byte goes on the wire and participates in caching.
      content.push({ type: 'text', text: '.' })
    }
    return
  }
  const insertIndex = Math.max(0, content.length - 1)
  content.splice(insertIndex, 0, block)
}
