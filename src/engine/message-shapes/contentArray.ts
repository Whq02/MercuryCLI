import { isRecord } from '../../platform/primitives/isRecord.js'

export function insertBlockAfterToolResults(content: unknown[], block: unknown): void {
  const lastToolResultIndex = content.findLastIndex(item => isRecord(item) && item.type === 'tool_result')
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
