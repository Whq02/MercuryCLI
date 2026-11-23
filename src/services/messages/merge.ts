import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { contentItemsOf, joinContentAtTextSeam, resultsFirst, storedBlocksOf } from '../../rows/content.js'
import { isToolReferenceBlock } from './toolSearch.js'

type ContentJoin = (left: ContentBlockParam[], right: ContentBlockParam[]) => ContentBlockParam[]
type ToolResultContentItem = Exclude<NonNullable<ToolResultBlockParam['content']>, string>[number]
const isTextBlock = (block: { type: string }): block is TextBlockParam => block.type === 'text'

function composeUser(left: UserMessage, right: UserMessage, join: ContentJoin): UserMessage {
  const content = join(normalizeUserTextContent(left.message.content), normalizeUserTextContent(right.message.content))
  return { ...left, message: { ...left.message, content: hoistToolResults(content) } }
}

export function mergeUserMessages(left: UserMessage, right: UserMessage): UserMessage {
  const joined = composeUser(left, right, joinTextAtSeam)
  joined.uuid = left.isMeta ? right.uuid : left.uuid
  return joined
}

export function mergeUserMessagesAndToolResults(left: UserMessage, right: UserMessage): UserMessage {
  if (right.queued !== true) return composeUser(left, right, mergeUserContentBlocks)
  const content = [...normalizeUserTextContent(left.message.content), ...normalizeUserTextContent(right.message.content)]
  return { ...left, message: { ...left.message, content: hoistToolResults(content) } }
}

export function mergeAssistantMessages(left: AssistantMessage, right: AssistantMessage): AssistantMessage {
  const content = [...storedBlocksOf(left.message.content), ...storedBlocksOf(right.message.content)]
  return { ...left, message: { ...left.message, content: content as AssistantMessage['message']['content'] } }
}

export function mergeUserContentBlocks(left: ContentBlockParam[], right: ContentBlockParam[]): ContentBlockParam[] {
  const last = left.at(-1)
  if (last?.type === 'tool_result' && typeof last.content === 'string' && right.every(isTextBlock)) {
    const folded = smooshIntoToolResult(last, right)
    if (folded !== null) {
      const merged = left.slice(0, -1)
      merged.push(folded)
      return merged
    }
  }
  return [...left, ...right]
}

export function isToolResultMessage(row: Message): boolean {
  return row.type === 'user' && typeof row.message.content !== 'string' && contentItemsOf(row.message.content).some(item => item.type === 'tool_result')
}

function normalizeUserTextContent(content: string | ContentBlockParam[]): ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

export function hoistToolResults(content: ContentBlockParam[]): ContentBlockParam[] {
  return resultsFirst(content) as ContentBlockParam[]
}

export function joinTextAtSeam(left: ContentBlockParam[], right: ContentBlockParam[]): ContentBlockParam[] {
  return joinContentAtTextSeam(left, right) as ContentBlockParam[]
}

function presentItemsOf(content: ToolResultBlockParam['content']): ToolResultContentItem[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

export function smooshIntoToolResult(tr: ToolResultBlockParam, blocks: ContentBlockParam[]): ToolResultBlockParam | null {
  if (blocks.length === 0) return tr
  const present = tr.content
  if (Array.isArray(present) && present.some(isToolReferenceBlock)) return null
  const incoming = tr.is_error ? blocks.filter(isTextBlock) : blocks
  if (incoming.length === 0) return tr
  const folded = foldTextRuns([...presentItemsOf(present), ...incoming])
  if (Array.isArray(present) || !incoming.every(isTextBlock)) return { ...tr, content: folded }
  return { ...tr, content: folded.flatMap(item => (isTextBlock(item) ? [item.text] : [])).join('\n\n') }
}

function foldTextRuns(items: ReadonlyArray<ToolResultContentItem | ContentBlockParam>): ToolResultContentItem[] {
  const folded: ToolResultContentItem[] = []
  let run: string[] = []
  const closeRun = (): void => {
    if (run.length > 0) folded.push({ type: 'text', text: run.join('\n\n') })
    run = []
  }
  for (const item of items) {
    if (isTextBlock(item)) {
      const text = item.text.trim()
      if (text) run.push(text)
      continue
    }
    closeRun()
    folded.push(item as ToolResultContentItem)
  }
  closeRun()
  return folded
}
