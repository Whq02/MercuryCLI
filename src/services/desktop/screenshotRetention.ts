import { existsSync, readFileSync } from 'node:fs'
import type { Message } from '../../types/message.js'
import type { ContentBlockParam, ToolResultBlockParam } from '../../types/wire.js'
import { getLastApiCompletionTimestamp } from '../../bootstrap/state.js'
import { cacheClockSnapshot } from '../../utils/cache/cacheClock.js'
import { TTL_MS } from '../../utils/cache/cacheClockCore.js'
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import { conversationEditKey, settleWireEdits, type WireEdit } from '../../utils/messages/wireEdits.js'
import { noteScreenshot, screenshotPathForToolUse } from './desktopSession.js'
import { COMPUTER_TOOL_NAME } from './toolName.js'

export const SCREENSHOT_KEEP_RECENT = 3
export const SCREENSHOT_WIRE_HIGH_WATER = 12
export const SCREENSHOT_WIRE_CEILING = 96

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

export function projectForTranscript<M extends Message>(message: M, transcript: readonly Message[] | null = null): M {
  const blocks = userBlocks(message)
  if (blocks === null) return message
  const needsPairing = transcript !== null && blocks.some(block => block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(part => part.type === 'image') && screenshotPathForToolUse(block.tool_use_id) === null)
  const paired = needsPairing ? computerToolUseIdsBefore(transcript, transcript.length) : null
  let touched = false
  const projected = blocks.map(block => {
    if (!isScreenshotResult(block, paired)) return block
    touched = true
    return withImagesReplaced(block, screenshotStubText(screenshotPathOf(block)))
  })
  return touched ? rebuildUser(message, projected) : message
}

const STUB_TEXT = /^\[screenshot not kept in the conversation file — the image is at (.+); take a new screenshot before acting\]$/

function stubPathOf(part: ResultBlock): string | null {
  if (part.type !== 'text') return null
  return STUB_TEXT.exec(part.text)?.[1] ?? null
}

function imageBlockFromFile(file: string): ResultBlock | null {
  for (const candidate of [`${file}.inline`, file]) {
    try {
      if (!existsSync(candidate)) continue
      const bytes = readFileSync(candidate)
      return { type: 'image', source: { type: 'base64', media_type: detectImageFormatFromBuffer(bytes), data: bytes.toString('base64') } }
    } catch {
      continue
    }
  }
  return null
}

export function rehydrateScreenshots<M extends Message>(messages: M[]): M[] {
  let changed = false
  const out = messages.map(message => {
    const blocks = userBlocks(message)
    if (blocks === null) return message
    let touched = false
    const rebuilt = blocks.map(block => {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block
      const parts = block.content as ResultBlock[]
      const at = parts.findIndex(part => stubPathOf(part) !== null)
      if (at === -1) return block
      const file = stubPathOf(parts[at]!)!
      const image = imageBlockFromFile(file)
      if (image === null) return block
      noteScreenshot(null, block.tool_use_id, file)
      touched = true
      return { ...block, content: parts.map((part, index) => (index === at ? image : part)) }
    })
    if (!touched) return message
    changed = true
    return rebuildUser(message, rebuilt)
  })
  return changed ? out : messages
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

interface RetiredScreenshots<M extends Message> {
  messages: M[]
  firstEdited: number
}

interface RetirementMoment {
  coldPrefix?: boolean
  now?: number
}

const retiredByConversation = new Map<string, Set<string>>()

export function resetScreenshotRetirementForTesting(): void {
  retiredByConversation.clear()
}

function lastAssistantTimestamp(messages: readonly Message[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]!
    if (row.type !== 'assistant') continue
    const at = Date.parse((row as { timestamp?: string }).timestamp ?? '')
    return Number.isFinite(at) ? at : null
  }
  return null
}

export function prefixIsCold(messages: readonly Message[], now: number = Date.now()): boolean {
  const basis = getLastApiCompletionTimestamp() ?? lastAssistantTimestamp(messages)
  if (basis === null) return true
  const ttl = cacheClockSnapshot().ttl ?? '5m'
  return now - basis > TTL_MS[ttl]
}

export function retireOlderScreenshots<M extends Message>(
  messages: M[],
  keep: number = SCREENSHOT_KEEP_RECENT,
  highWater: number = SCREENSHOT_WIRE_HIGH_WATER,
  owner?: string,
  moment?: RetirementMoment,
): RetiredScreenshots<M> {
  const live: Array<{ index: number; toolUseId: string }> = []
  messages.forEach((message, index) => {
    const blocks = userBlocks(message)
    if (blocks === null) return
    for (const block of blocks) {
      if (isScreenshotResult(block)) live.push({ index, toolUseId: block.tool_use_id })
    }
  })
  const conversation = owner === undefined ? null : conversationEditKey(owner, messages)
  const remembered = conversation === null ? new Set<string>() : (retiredByConversation.get(conversation) ?? new Set<string>())
  const liveIds = new Set(live.map(entry => entry.toolUseId))
  const held = new Set([...remembered].filter(id => liveIds.has(id)))
  const unretired = live.filter(entry => !held.has(entry.toolUseId))
  const cold = moment?.coldPrefix ?? prefixIsCold(messages, moment?.now)
  const ceilingReached = unretired.length > SCREENSHOT_WIRE_CEILING
  const retiring = new Set(held)
  if (live.length > Math.max(0, highWater) && (cold || ceilingReached)) {
    const retireCount = Math.max(0, live.length - Math.max(0, keep))
    for (const entry of live.slice(0, retireCount)) retiring.add(entry.toolUseId)
  }
  if (conversation !== null && retiring.size > 0) retiredByConversation.set(conversation, new Set(retiring))
  const retired = new Map<number, Set<string>>()
  for (const entry of live) {
    if (!retiring.has(entry.toolUseId)) continue
    const ids = retired.get(entry.index)
    if (ids) ids.add(entry.toolUseId)
    else retired.set(entry.index, new Set([entry.toolUseId]))
  }
  if (retired.size === 0) return { messages, firstEdited: -1 }
  const edits: WireEdit[] = []
  const projected = messages.map((message, index) => {
    const ids = retired.get(index)
    if (ids === undefined) return message
    const blocks = userBlocks(message)
    if (blocks === null) return message
    const rebuilt = blocks.map(block => {
      if (!isScreenshotResult(block) || !ids.has(block.tool_use_id)) return block
      edits.push({ index, key: `retired:${block.tool_use_id}` })
      return withImagesReplaced(block, earlierScreenshotText(screenshotPathForToolUse(block.tool_use_id) ?? ''))
    })
    return rebuildUser(message, rebuilt)
  })
  return settleWireEdits(owner, projected, edits)
}
