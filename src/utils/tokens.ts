import { roughTokenCountEstimationForMessages } from '../services/tokenEstimation.js'
import type { AssistantMessage, Message } from '../types/message.js'
import type { ApiUsage } from '../types/wire.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from './messages.js'

function usageFamilyOf(model: string): string {
  const { declaredRouteOf } = require('../services/providers/routeLaw.js') as typeof import('../services/providers/routeLaw.js')
  return declaredRouteOf(model) ?? 'anthropic'
}

function usageAnchorForeign(anchor: Message, model: string | undefined): boolean {
  if (model === undefined || anchor.type !== 'assistant') return false
  const stamped = (anchor as AssistantMessage).message?.model
  if (typeof stamped !== 'string' || stamped === '' || stamped === SYNTHETIC_MODEL) return false
  return usageFamilyOf(stamped) !== usageFamilyOf(model)
}


type ContentBlockLike = {
  type?: string
  text?: string
  thinking?: string
  data?: string
  input?: unknown
}

function isPlaceholderUsage(usage: ApiUsage): boolean {
  const iterations = (usage as { iterations?: unknown }).iterations
  if (Array.isArray(iterations) && iterations.length > 0) return false
  return (
    (usage.input_tokens ?? 0) +
      (usage.output_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) <=
    0
  )
}

export function getTokenUsage(message: Message | undefined): ApiUsage | undefined {
  if (!message || message.type !== 'assistant') return undefined
  const apiMessage = (message as AssistantMessage).message
  const usage = apiMessage?.usage
  if (!usage) return undefined
  const content = apiMessage.content
  const firstBlock = Array.isArray(content) ? (content[0] as ContentBlockLike | undefined) : undefined
  if (
    firstBlock?.type === 'text' &&
    typeof firstBlock.text === 'string' &&
    SYNTHETIC_MESSAGES.has(firstBlock.text)
  ) {
    return undefined
  }
  if (apiMessage.model === SYNTHETIC_MODEL) return undefined
  if (isPlaceholderUsage(usage as ApiUsage)) return undefined
  return usage as ApiUsage
}

export function getTokenCountFromUsage(usage: ApiUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

export function tokenCountFromLastAPIResponse(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (usage) return getTokenCountFromUsage(usage)
  }
  return 0
}

export function finalContextTokensFromLastResponse(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (!usage) continue
    const iterations = usage.iterations as Array<{ input_tokens?: number; output_tokens?: number }> | null
    if (Array.isArray(iterations) && iterations.length > 0) {
      const last = iterations[iterations.length - 1] as { input_tokens?: number; output_tokens?: number }
      return (last.input_tokens ?? 0) + (last.output_tokens ?? 0)
    }
    return usage.input_tokens + usage.output_tokens
  }
  return 0
}

export function getCurrentUsage(messages: Message[]): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const usage = getTokenUsage(messages[index])
    if (!usage) continue
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    }
  }
  return null
}

export function doesMostRecentAssistantMessageExceed200k(messages: Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant') continue
    const usage = getTokenUsage(message)
    if (!usage) return false
    return getTokenCountFromUsage(usage) > 200_000
  }
  return false
}

export function getAssistantMessageContentLength(message: AssistantMessage): number {
  const content = message.message.content
  if (!Array.isArray(content)) return 0
  let length = 0
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      length += block.text.length
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      length += block.thinking.length
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      length += block.data.length
    } else if (block.type === 'tool_use' && block.input !== undefined) {
      length += JSON.stringify(block.input).length
    }
  }
  return length
}

export type ContextFill = { tokens: number; source: 'usage' | 'estimate' }

function compactUsageFence(
  messages: readonly Message[],
): { boundaryIndex: number; rehomedUuids: ReadonlySet<string> } | null {
  let boundaryIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { type?: string; subtype?: string }
    if (message?.type === 'system' && message.subtype === 'compact_boundary') {
      boundaryIndex = index
      break
    }
  }
  if (boundaryIndex === -1) return null
  const boundary = messages[boundaryIndex] as {
    uuid?: string
    compactMetadata?: { preservedSegment?: { headUuid?: string; anchorUuid?: string; tailUuid?: string } }
  }
  const rehomed = new Set<string>()
  const segment = boundary.compactMetadata?.preservedSegment
  if (segment?.headUuid !== undefined && segment.tailUuid !== undefined && segment.anchorUuid !== boundary.uuid) {
    let inside = false
    for (const message of messages) {
      const uuid = (message as { uuid?: string }).uuid
      if (uuid === segment.headUuid) inside = true
      if (inside && uuid !== undefined) rehomed.add(uuid)
      if (uuid === segment.tailUuid) break
    }
  }
  return { boundaryIndex, rehomedUuids: rehomed }
}

export function contextFill(messages: readonly Message[], model?: string): ContextFill {
  const fence = compactUsageFence(messages)
  let usageIndex = -1
  let usageTotal = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (fence !== null) {
      if (index <= fence.boundaryIndex) break
      const uuid = (messages[index] as { uuid?: string }).uuid
      if (uuid !== undefined && fence.rehomedUuids.has(uuid)) continue
    }
    const usage = getTokenUsage(messages[index])
    if (usage) {
      if (usageAnchorForeign(messages[index]!, model)) break
      usageIndex = index
      usageTotal = getTokenCountFromUsage(usage)
      break
    }
  }
  if (usageIndex === -1) {
    return { tokens: roughTokenCountEstimationForMessages(messages as never), source: 'estimate' }
  }

  let anchor = usageIndex
  const usageMessage = (messages[usageIndex] as AssistantMessage).message
  const responseId = usageMessage.id
  const settled = usageMessage.stop_reason !== null && usageMessage.stop_reason !== undefined
  if (responseId) {
    for (let index = usageIndex - 1; index >= 0; index--) {
      const message = messages[index]
      const id =
        message?.type === 'assistant' ? (message as AssistantMessage).message?.id : undefined
      if (id === undefined || id === null) continue
      if (id === responseId) {
        anchor = index
        continue
      }
      break
    }
  }
  const tail = messages.slice(anchor + 1).filter(message => {
    if (!settled || !responseId || message.type !== 'assistant') return true
    return (message as AssistantMessage).message?.id !== responseId
  })
  return { tokens: usageTotal + roughTokenCountEstimationForMessages(tail as never), source: 'usage' }
}

export function tokenCountWithEstimation(messages: readonly Message[], model?: string): number {
  return contextFill(messages, model).tokens
}
