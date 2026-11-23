type ContentItem = { readonly type: string }

export function insertBlockAfterToolResults(content: ContentItem[], block: ContentItem): void {
  const lastToolResultIndex = content.findLastIndex(item => item.type === 'tool_result')
  if (lastToolResultIndex !== -1) {
    const insertIndex = lastToolResultIndex + 1
    if (insertIndex === content.length) {
      const period: ContentItem & { text: string } = { type: 'text', text: '.' }
      content.push(block, period)
    } else {
      content.splice(insertIndex, 0, block)
    }
    return
  }
  const insertIndex = content.length === 0 ? 0 : content.length - 1
  content.splice(insertIndex, 0, block)
}
