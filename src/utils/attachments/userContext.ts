import { getUserContext } from '../../context.js'
import type { Message } from '../../types/message.js'
import { userContextReminderBody } from '../userContextReminder.js'
import type { Attachment } from './types.js'

export function latestUserContextBody(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === 'attachment' && message.attachment.type === 'user_context') {
      return message.attachment.body
    }
  }
  return null
}

export async function getUserContextAttachment(
  messages: readonly Message[],
  context?: Record<string, string>,
): Promise<Attachment[]> {
  const body = userContextReminderBody(context ?? (await getUserContext()))
  if (body === null) return []
  if (latestUserContextBody(messages) === body) return []
  return [{ type: 'user_context', body }]
}
