import type { RenderableMessage } from '../../types/message.js'
import { isTurnBoundary } from '../../utils/cockpit/turnReceipt.js'
import { thinkingTextWithheld } from './AssistantThinkingMessage.js'

type Thinking = { thinking?: string; signature?: string }

export function withheldThinkingDisclosure(rows: RenderableMessage[]): {
  hidden: Set<string>
  byRow: Map<string, Thinking>
} {
  const hidden = new Set<string>()
  const byRow = new Map<string, Thinking>()
  let withheld: { uuid: string; block: Thinking } | null = null
  let answer: string | null = null
  let work: string | null = null
  const finish = (): void => {
    if (withheld) byRow.set(answer ?? work ?? withheld.uuid, withheld.block)
    withheld = null
    answer = null
    work = null
  }
  for (const row of rows) {
    if (isTurnBoundary(row)) finish()
    if (row.type === 'assistant') {
      const block = row.message.content[0]
      if (block?.type === 'thinking' && thinkingTextWithheld(block)) {
        hidden.add(row.uuid)
        withheld ??= { uuid: row.uuid, block }
      } else if (block?.type === 'text' && block.text.trim() !== '') {
        answer = row.uuid
      } else if (block?.type === 'tool_use') {
        work = row.uuid
      }
    } else if (row.type === 'grouped_tool_use' || row.type === 'collapsed_read_search' || row.type === 'turn_receipt') {
      work = row.uuid
    } else if (row.type === 'user' && row.message.content.some(block => block.type === 'tool_result')) {
      work = row.uuid
    }
  }
  finish()
  return { hidden, byRow }
}
