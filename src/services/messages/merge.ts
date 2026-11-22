import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { contentItemsOf, joinContentAtTextSeam, resultsFirst, storedBlocksOf } from '../../rows/content.js'
import { isToolReferenceBlock } from './toolSearch.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ContentJoin = (left: ContentBlockParam[], right: ContentBlockParam[]) => ContentBlockParam[]
type ToolResultContentItem = Unbuilt
const isTextBlock = (block: { type: string }): block is TextBlockParam => notBuilt('src/services/messages/merge.ts:8')

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
  return notBuilt('src/services/messages/merge.ts:21')
}

export function mergeAssistantMessages(left: AssistantMessage, right: AssistantMessage): AssistantMessage {
  const content = [...storedBlocksOf(left.message.content), ...storedBlocksOf(right.message.content)]
  return { ...left, message: { ...left.message, content: content as AssistantMessage['message']['content'] } }
}

export function mergeUserContentBlocks(left: ContentBlockParam[], right: ContentBlockParam[]): ContentBlockParam[] {
  return notBuilt('src/services/messages/merge.ts:34')
}

export function isToolResultMessage(row: Message): boolean {
  return notBuilt('src/services/messages/merge.ts:42')
}

function normalizeUserTextContent(content: string | ContentBlockParam[]): ContentBlockParam[] {
  return notBuilt('src/services/messages/merge.ts:47')
}

export function hoistToolResults(content: ContentBlockParam[]): ContentBlockParam[] {
  return notBuilt('src/services/messages/merge.ts:51')
}

export function joinTextAtSeam(left: ContentBlockParam[], right: ContentBlockParam[]): ContentBlockParam[] {
  return joinContentAtTextSeam(left, right) as ContentBlockParam[]
}

export function smooshIntoToolResult(tr: ToolResultBlockParam, blocks: ContentBlockParam[]): ToolResultBlockParam | null {
  return notBuilt('src/services/messages/merge.ts:59')
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
