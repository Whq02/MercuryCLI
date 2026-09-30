import type { Message, NormalizedMessage } from '../../types/message.js'
import { contentBlocksOf } from './normalize.js'
import { isTurnCutText } from './turnCut.js'

export type OpenToolUses = {
  owners: Map<string, string>
}

export const freshOpenToolUses = (): OpenToolUses => ({ owners: new Map() })

export const cloneOpenToolUses = (fold: OpenToolUses): OpenToolUses => ({ owners: new Map(fold.owners) })

function isCutRow(content: unknown): boolean {
  if (typeof content === 'string') return isTurnCutText(content)
  if (!Array.isArray(content)) return false
  return content.some(block => {
    const record = block as { type?: string; text?: unknown }
    return record.type === 'text' && typeof record.text === 'string' && isTurnCutText(record.text)
  })
}

export function accumulateOpenToolUses(fold: OpenToolUses, message: Message | NormalizedMessage): void {
  if (message.type === 'assistant') {
    if (message.isVirtual === true) return
    const apiId = (message.message as { id?: unknown }).id
    const owner = typeof apiId === 'string' && apiId !== '' ? apiId : message.uuid
    for (const [id, holder] of fold.owners) {
      if (holder !== owner) fold.owners.delete(id)
    }
    for (const block of contentBlocksOf(message.message.content)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') fold.owners.set(block.id, owner)
    }
    return
  }
  if (message.type !== 'user') return
  const local = message as { queued?: boolean; isVirtual?: boolean; isVisibleInTranscriptOnly?: boolean }
  if (local.queued === true || local.isVirtual === true || local.isVisibleInTranscriptOnly === true) return
  const content = message.message.content
  let carriedToolResult = false
  if (Array.isArray(content)) {
    for (const block of content) {
      const record = block as { type?: string; tool_use_id?: string }
      if (record.type === 'tool_result' && typeof record.tool_use_id === 'string') {
        fold.owners.delete(record.tool_use_id)
        carriedToolResult = true
      }
    }
  }
  if (!carriedToolResult && !message.isMeta && !isCutRow(content)) fold.owners.clear()
}

export function openToolUseIDs(fold: OpenToolUses): Set<string> {
  return new Set(fold.owners.keys())
}

export function openToolUseIDsOf(messages: readonly (Message | NormalizedMessage)[]): Set<string> {
  const fold = freshOpenToolUses()
  for (const message of messages) accumulateOpenToolUses(fold, message)
  return openToolUseIDs(fold)
}
