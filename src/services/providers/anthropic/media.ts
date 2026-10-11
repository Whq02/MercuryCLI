import type { AssistantMessage, UserMessage } from '../../../types/message.js'
import type { ContentBlockParam, DocumentBlockParam, ImageBlockParam, ToolResultBlockParam } from '../../../types/wire.js'
import { stripThinkingFromIndex } from '../../../utils/messages/apiFilters.js'

type Turn = UserMessage | AssistantMessage

export function isMedia(block: ContentBlockParam): block is ImageBlockParam | DocumentBlockParam {
  return block.type === 'image' || block.type === 'document'
}

export function isToolResult(block: ContentBlockParam): block is ToolResultBlockParam {
  return block.type === 'tool_result'
}

const blocksOf = (msg: Turn): ContentBlockParam[] | null => (Array.isArray(msg.message.content) ? msg.message.content : null)

const nestedBlocksOf = (block: ContentBlockParam): ContentBlockParam[] =>
  isToolResult(block) && Array.isArray(block.content) ? (block.content as ContentBlockParam[]) : []

const mediaIn = (blocks: ContentBlockParam[]): number => blocks.filter(isMedia).length

const mediaCountOf = (turn: Turn): number => {
  const blocks = blocksOf(turn) ?? []
  return mediaIn(blocks) + mediaIn(blocks.flatMap(nestedBlocksOf))
}

export function stripExcessMediaItems(messages: Turn[], limit: number): Turn[] {
  let owed = messages.reduce((sum, turn) => sum + mediaCountOf(turn), 0) - limit
  if (owed <= 0) return messages

  const takenAsPayment = (block: ContentBlockParam): boolean => {
    if (owed <= 0 || !isMedia(block)) return false
    owed--
    return true
  }
  const withoutNestedMedia = (block: ContentBlockParam): ContentBlockParam => {
    if (owed <= 0 || !isToolResult(block) || !Array.isArray(block.content)) return block
    const kept = block.content.filter(inner => !takenAsPayment(inner as ContentBlockParam))
    return kept.length === block.content.length ? block : { ...block, content: kept }
  }
  const settled = (turn: Turn): Turn => {
    const blocks = blocksOf(turn)
    if (owed <= 0 || !blocks) return turn
    const owedBefore = owed
    const remaining = blocks.map(withoutNestedMedia).filter(block => !takenAsPayment(block))
    return owedBefore === owed ? turn : ({ ...turn, message: { ...turn.message, content: remaining } } as Turn)
  }

  const stripped = messages.map(settled)
  const firstEdited = stripped.findIndex((turn, index) => turn !== messages[index])
  return firstEdited === -1 ? stripped : stripThinkingFromIndex(stripped, firstEdited)
}
