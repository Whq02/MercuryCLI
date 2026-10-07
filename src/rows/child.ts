import type { AssistantMessage, Message } from '../types/message.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import { updateUsage } from '../services/providers/anthropic/cacheAndUsage.js'
import { itemRowsOf, refusedCallRowsOf, stepRow, toolResultRowsOf, type RowDraft, type RowScope } from './project.js'

const messages = new Map<string, { block: number; stepped: boolean; seen: Set<string> }>()

export function childRowsOf(scope: RowScope & { parent_call_id: string }, message: Message): RowDraft[] {
  if (message.type === 'user') return toolResultRowsOf(scope, message.message.content)
  if (message.type !== 'assistant') return []
  const assistant = message as AssistantMessage & { isApiErrorMessage?: boolean }
  if (assistant.isApiErrorMessage === true) return []
  const messageId = assistant.message.id ?? assistant.uuid
  const key = JSON.stringify([scope.session_id, scope.parent_call_id, messageId])
  let cursor = messages.get(key)
  if (cursor === undefined) {
    cursor = { block: 0, stepped: false, seen: new Set() }
    messages.set(key, cursor)
    if (messages.size > 1000) messages.delete(messages.keys().next().value!)
  }
  const rows: RowDraft[] = []
  if (!cursor.seen.has(assistant.uuid)) {
    cursor.seen.add(assistant.uuid)
    rows.push(...itemRowsOf(scope, messageId, assistant.message.content, cursor.block))
    cursor.block += Array.isArray(assistant.message.content) ? assistant.message.content.length : 1
    const refused = assistant.refusedToolCalls ?? []
    if (refused.length > 0) {
      rows.push(...refusedCallRowsOf(scope, messageId, refused, cursor.block))
      cursor.block += refused.length
    }
  }
  if (!cursor.stepped && assistant.message.stop_reason != null) {
    cursor.stepped = true
    rows.push(stepRow(scope, { messageId, model: assistant.message.model, stopReason: assistant.message.stop_reason, usage: updateUsage(EMPTY_USAGE, assistant.message.usage) }))
  }
  return rows
}
