
import type { ContentBlockParam, TextBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import last from 'lodash-es/last.js'
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
  const toolResults: ContentBlockParam[] = []
  const otherBlocks: ContentBlockParam[] = []
  for (const block of content) {
    if (block.type === 'tool_result') toolResults.push(block)
    else otherBlocks.push(block)
  }
  return [...toolResults, ...otherBlocks]
}

export function joinTextAtSeam(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  const lastA = a.at(-1)
  const firstB = b[0]
  if (lastA?.type === 'text' && firstB?.type === 'text') {
    return [...a.slice(0, -1), { ...lastA, text: lastA.text + '\n' }, ...b]
  }
  return [...a, ...b]
}

type ToolResultContentItem = Extract<
  ToolResultBlockParam['content'],
  readonly unknown[]
>[number]

export function smooshIntoToolResult(
  tr: ToolResultBlockParam,
  blocks: ContentBlockParam[],
): ToolResultBlockParam | null {
  if (blocks.length === 0) return tr

  const existing = tr.content
  if (Array.isArray(existing) && existing.some(isToolReferenceBlock)) {
    return null
  }

  if (tr.is_error) {
    blocks = blocks.filter(b => b.type === 'text')
    if (blocks.length === 0) return tr
  }

  const allText = blocks.every(b => b.type === 'text')
  if (allText && (existing === undefined || typeof existing === 'string')) {
    const joined = [
      (existing ?? '').trim(),
      ...blocks.map(b => (b as TextBlockParam).text.trim()),
    ]
      .filter(Boolean)
      .join('\n\n')
    return { ...tr, content: joined }
  }

  const base: ToolResultContentItem[] =
    existing === undefined
      ? []
      : typeof existing === 'string'
        ? existing.trim()
          ? [{ type: 'text', text: existing.trim() }]
          : []
        : [...existing]

  const merged: ToolResultContentItem[] = []
  for (const b of [...base, ...blocks]) {
    if (b.type === 'text') {
      const t = b.text.trim()
      if (!t) continue
      const prev = merged.at(-1)
      if (prev?.type === 'text') {
        merged[merged.length - 1] = { ...prev, text: `${prev.text}\n\n${t}` }
      } else {
        merged.push({ type: 'text', text: t })
      }
    } else {
      merged.push(b as ToolResultContentItem)
    }
  }
  return { ...tr, content: merged }
}

export function mergeUserContentBlocks(
  a: ContentBlockParam[],
  b: ContentBlockParam[],
): ContentBlockParam[] {
  const lastBlock = last(a)
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
      content: [...a.message.content, ...b.message.content],
    },
  }
}

export function isToolResultMessage(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message.content
  if (typeof content === 'string') return false
  return content.some(block => block.type === 'tool_result')
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
