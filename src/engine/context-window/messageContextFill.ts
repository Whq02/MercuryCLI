import { roughTokenCountEstimationForMessages } from './roughTokenEstimation.js'
import type { AssistantMessage, Message } from '../message-shapes/message.js'
import type { ApiUsage } from '../message-shapes/wire.js'
import { getTokenCountFromUsage } from './tokenUsage.js'
import { SYNTHETIC_MESSAGES, SYNTHETIC_MODEL } from '../message-shapes/factories.js'

function usageFamilyOf(model: string): string | null {
  const { declaredRouteOf } = require('../../models/roads/routeLaw.js') as typeof import('../../models/roads/routeLaw.js')
  return declaredRouteOf(model)
}

function usageAnchorForeign(anchor: Message, model: string | undefined): boolean {
  if (model === undefined || anchor.type !== 'assistant') return false
  const stamped = (anchor as AssistantMessage).message?.model
  if (typeof stamped !== 'string' || stamped === '' || stamped === SYNTHETIC_MODEL) return false
  const stampedFamily = usageFamilyOf(stamped)
  const seatedFamily = usageFamilyOf(model)
  return stampedFamily !== null && seatedFamily !== null && stampedFamily !== seatedFamily
}

export type ContentBlockLike = {
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

export function messageContextFill(messages: readonly Message[], model?: string): ContextFill {
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
    return { tokens: roughTokenCountEstimationForMessages(fence === null ? messages : messages.slice(fence.boundaryIndex), model), source: 'estimate' }
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
  return { tokens: usageTotal + roughTokenCountEstimationForMessages(tail, model), source: 'usage' }
}
