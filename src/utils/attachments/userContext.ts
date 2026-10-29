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
  opening = true,
): Promise<Attachment[]> {
  const current = context ?? (await getUserContext())
  const previous = messages.findLast(message => message.type === 'attachment' && message.attachment.type === 'user_context')
  const prior = previous?.type === 'attachment' && previous.attachment.type === 'user_context' ? previous.attachment : null
  const delivered = opening ? current : Object.fromEntries(Object.entries(current).filter(([key, value]) => key !== 'environment' && key !== 'currentDate' && prior?.context?.[key] !== value))
  const body = userContextReminderBody(delivered)
  if (body === null || prior?.body === body) return []
  return [{ type: 'user_context', body, context: current }]
}
