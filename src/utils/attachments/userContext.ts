// utils/attachments/userContext — the main conversation's user context as a
// persisted attachment row (the append-only form of the per-request
// prepend). Mercury-owned.
//
// The preserved-thinking check (Claude Fable 5.1) binds every thinking block
// to the exact prefix that produced it. A user context prepended fresh on
// every request is part of that prefix, and a resumed process rebuilds it
// (a new day, an edited instruction file) — every earlier thinking block is
// then invalid. This producer emits the context ONCE, as a row the transcript
// persists and every later request replays byte-identical, and emits a fresh
// copy at the tail only when the rendered body changes; the earlier copies
// stay where they are. The model reads the newest copy.
import { getUserContext } from '../../context.js'
import type { Message } from '../../types/message.js'
import { userContextReminderBody } from '../userContextReminder.js'
import type { Attachment } from './types.js'

/** The newest persisted user-context body in the history, or null. */
export function latestUserContextBody(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === 'attachment' && message.attachment.type === 'user_context') {
      return message.attachment.body
    }
  }
  return null
}

/**
 * The attachment to emit for this turn: one row when the history carries no
 * user context or carries a different one; nothing when the newest copy
 * already says what the current context says. Pure over its inputs when the
 * context is passed; the production caller reads the memoized session
 * context.
 */
export async function getUserContextAttachment(
  messages: readonly Message[],
  context?: Record<string, string>,
): Promise<Attachment[]> {
  const body = userContextReminderBody(context ?? (await getUserContext()))
  if (body === null) return []
  if (latestUserContextBody(messages) === body) return []
  return [{ type: 'user_context', body }]
}
