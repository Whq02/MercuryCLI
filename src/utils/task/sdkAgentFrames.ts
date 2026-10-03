import { getSessionId } from '../../bootstrap/state.js'
import { itemRowsOf, toolResultRowsOf } from '../../rows/project.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { normalizeMessages } from '../messages.js'
import { enqueueRow } from '../sdkEventQueue.js'

const blockCursors = new Map<string, number>()

export function emitBackgroundAgentRows(parentToolUseId: string | undefined, message: Message): void {
  if (parentToolUseId === undefined || parentToolUseId === '') return
  if (message.type !== 'assistant' && message.type !== 'user') return
  const scope = { session_id: getSessionId(), parent_call_id: parentToolUseId }
  if (message.type === 'assistant') {
    const assistant = message as AssistantMessage & { isApiErrorMessage?: boolean }
    if (assistant.isApiErrorMessage === true) return
    const messageId = assistant.message.id ?? (assistant.uuid as string)
    const content = assistant.message.content
    const base = blockCursors.get(messageId) ?? 0
    blockCursors.set(messageId, base + (Array.isArray(content) ? content.length : 1))
    if (blockCursors.size > 500) blockCursors.delete(blockCursors.keys().next().value as string)
    for (const normalized of normalizeMessages([message])) {
      for (const row of itemRowsOf(scope, messageId, (normalized as AssistantMessage).message.content, base)) enqueueRow(row)
    }
    return
  }
  for (const row of toolResultRowsOf(scope, (message as { message: { content: unknown } }).message.content)) enqueueRow(row)
}
