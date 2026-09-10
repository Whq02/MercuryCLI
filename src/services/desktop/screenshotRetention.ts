import type { Message } from '../../types/message.js'
import type { ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { screenshotPathForToolUse } from './desktopSession.js'
import { COMPUTER_TOOL_NAME } from './toolName.js'

export const SCREENSHOT_KEEP_RECENT = 3
export const SCREENSHOT_WIRE_HIGH_WATER = 12

export function screenshotStubText(filePath: string): string {
  return `[screenshot not kept in the conversation file — the image is at ${filePath}; take a new screenshot before acting]`
}

export function earlierScreenshotText(filePath: string): string {
  return `[earlier screenshot — no longer in view; the image is at ${filePath}; act on the latest screenshot]`
}

type ResultBlock = Extract<NonNullable<ToolResultBlockParam['content']>, unknown[]>[number]

function userBlocks(message: Message): ContentBlockParam[] | null {
  if (message.type !== 'user') return null
  const content = message.message.content
  return Array.isArray(content) ? content : null
}

function isScreenshotResult(
  block: ContentBlockParam,
  paired: ReadonlySet<string> | null = null,
): block is ToolResultBlockParam & { content: ResultBlock[] } {
  if (block.type !== 'tool_result') return false
  if (!Array.isArray(block.content)) return false
  if (screenshotPathForToolUse(block.tool_use_id) === null && !(paired?.has(block.tool_use_id) ?? false)) return false
  return block.content.some(nested => nested.type === 'image')
}

const SCREENSHOT_LINE = /screenshot: (.+?) — display \d/

function screenshotPathOf(block: ToolResultBlockParam & { content: ResultBlock[] }): string {
  const registered = screenshotPathForToolUse(block.tool_use_id)
  if (registered !== null) return registered
  for (const nested of block.content) {
    if (nested.type !== 'text') continue
    const match = SCREENSHOT_LINE.exec(nested.text)
    if (match?.[1]) return match[1]
  }
  return ''
}

export function computerToolUseIdsBefore(transcript: readonly Message[], index: number): ReadonlySet<string> {
  const ids = new Set<string>()
  for (let at = index - 1; at >= 0; at--) {
    const earlier = transcript[at]
    if (earlier === undefined || earlier.type !== 'assistant') continue
    const content = earlier.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === COMPUTER_TOOL_NAME) ids.add(block.id)
      }
    }
    break
  }
  return ids
}

function withImagesReplaced(block: ToolResultBlockParam & { content: ResultBlock[] }, text: string): ToolResultBlockParam {
  return {
    ...block,
    content: block.content.map(nested => (nested.type === 'image' ? { type: 'text' as const, text } : nested)),
  }
}

function rebuildUser<M extends Message>(message: M, blocks: ContentBlockParam[]): M {
  const carrier = message as M & { message: { content: unknown } }
  return { ...carrier, message: { ...carrier.message, content: blocks } } as M
}

export function projectForTranscript<M extends Message>(message: M, index = -1, transcript: readonly Message[] | null = null): M {
  const blocks = userBlocks(message)
  if (blocks === null) return message
  const paired = transcript !== null && index >= 0 ? computerToolUseIdsBefore(transcript, index) : null
  let touched = false
  const projected = blocks.map(block => {
    if (!isScreenshotResult(block, paired)) return block
    touched = true
    return withImagesReplaced(block, screenshotStubText(screenshotPathOf(block)))
  })
  return touched ? rebuildUser(message, projected) : message
}

export function screenshotVisibleInContext(messages: readonly Message[], toolUseId: string): boolean {
  for (const message of messages) {
    const blocks = userBlocks(message)
    if (blocks === null) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue
      return Array.isArray(block.content) && block.content.some(nested => nested.type === 'image')
    }
  }
  return false
}

export interface RetiredScreenshots<M extends Message> {
  messages: M[]
  firstEdited: number
}

export function retireOlderScreenshots<M extends Message>(
  messages: M[],
  keep: number = SCREENSHOT_KEEP_RECENT,
  highWater: number = SCREENSHOT_WIRE_HIGH_WATER,
): RetiredScreenshots<M> {
  const live: Array<{ index: number; toolUseId: string }> = []
  messages.forEach((message, index) => {
    const blocks = userBlocks(message)
    if (blocks === null) return
    for (const block of blocks) {
      if (isScreenshotResult(block)) live.push({ index, toolUseId: block.tool_use_id })
    }
  })
  if (live.length <= Math.max(0, highWater)) return { messages, firstEdited: -1 }
  const retireCount = Math.max(0, live.length - Math.max(0, keep))
  const retired = new Map<number, Set<string>>()
  for (const entry of live.slice(0, retireCount)) {
    const ids = retired.get(entry.index)
    if (ids) ids.add(entry.toolUseId)
    else retired.set(entry.index, new Set([entry.toolUseId]))
  }
  if (retired.size === 0) return { messages, firstEdited: -1 }
  let firstEdited = -1
  const projected = messages.map((message, index) => {
    const ids = retired.get(index)
    if (ids === undefined) return message
    const blocks = userBlocks(message)
    if (blocks === null) return message
    const rebuilt = blocks.map(block => {
      if (!isScreenshotResult(block) || !ids.has(block.tool_use_id)) return block
      return withImagesReplaced(block, earlierScreenshotText(screenshotPathForToolUse(block.tool_use_id) ?? ''))
    })
    if (firstEdited === -1) firstEdited = index
    return rebuildUser(message, rebuilt)
  })
  return { messages: projected, firstEdited }
}
