
import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { contentItemsOf, joinContentAtTextSeam, resultsFirst, storedBlocksOf } from '../../rows/content.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { isToolReferenceBlock } from '../toolSearch.js'

export function normalizeUserTextContent(
  a: string | ContentBlockParam[],
): ContentBlockParam[] {
  return typeof a === 'string' ? [{ type: 'text', text: a }] : a
}

export function hoistToolResults(
  content: ContentBlockParam[],
): ContentBlockParam[] {
  return resultsFirst(content) as ContentBlockParam[]
}

export function joinTextAtSeam(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  return joinContentAtTextSeam(a, b) as ContentBlockParam[]
}

type ToolResultContentItem = Extract<
  ToolResultBlockParam['content'],
  readonly unknown[]
>[number]

const isTextBlock = (block: { type: string }): block is TextBlockParam => block.type === 'text'

function existingItemsOf(content: ToolResultBlockParam['content']): readonly ToolResultContentItem[] {
  if (content === undefined) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content
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

export function smooshIntoToolResult(
  tr: ToolResultBlockParam,
  blocks: ContentBlockParam[],
): ToolResultBlockParam | null {
  if (blocks.length === 0) return tr
  const existing = tr.content
  if (Array.isArray(existing) && existing.some(isToolReferenceBlock)) return null
  const incoming = tr.is_error ? blocks.filter(isTextBlock) : blocks
  if (incoming.length === 0) return tr
  const folded = foldTextRuns([...existingItemsOf(existing), ...incoming])
  if (!Array.isArray(existing) && incoming.every(isTextBlock)) {
    return { ...tr, content: folded.map(item => (item as TextBlockParam).text).join('\n\n') }
  }
  return { ...tr, content: folded }
}

export function mergeUserContentBlocks(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  const lastBlock = a.at(-1)
  if (lastBlock?.type !== 'tool_result') {
    return [...a, ...b]
  }
  if (
    typeof lastBlock.content === 'string' &&
    b.every(x => x.type === 'text')
  ) {
    const copy = a.slice()
    copy[copy.length - 1] = smooshIntoToolResult(lastBlock, b)!
    return copy
  }
  return [...a, ...b]
}

export function mergeUserMessagesAndToolResults(
  a: UserMessage,
  b: UserMessage,
): UserMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: hoistToolResults(
        mergeUserContentBlocks(
          normalizeUserTextContent(a.message.content),
          normalizeUserTextContent(b.message.content),
        ),
      ),
    },
  }
}

export function mergeAssistantMessages(
  a: AssistantMessage,
  b: AssistantMessage,
): AssistantMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: [...storedBlocksOf(a.message.content), ...storedBlocksOf(b.message.content)] as AssistantMessage['message']['content'],
    },
  }
}

export function isToolResultMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message.content
  if (typeof content === 'string') return false
  return contentItemsOf(content).some(item => item.type === 'tool_result')
}

export function mergeUserMessages(a: UserMessage, b: UserMessage): UserMessage {
  return {
    ...a,
    uuid: a.isMeta ? b.uuid : a.uuid,
    message: {
      ...a.message,
      content: hoistToolResults(
        joinTextAtSeam(
          normalizeUserTextContent(a.message.content),
          normalizeUserTextContent(b.message.content),
        ),
      ),
    },
  }
}
