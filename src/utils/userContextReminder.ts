// utils/userContextReminder — the user-context reminder body (the instruction
// files and the session date the model reads beside the conversation). ONE
// builder: the persisted user_context attachment the main thread carries
// (utils/attachments/userContext.ts) and the per-request prepend that agent
// threads and one-shots still use (utils/api.ts prependUserContext) render
// the same bytes, so a conversation never sees two spellings of its context.
// Mercury-owned. No imports: both callers reach it without a cycle.

export const USER_CONTEXT_REMINDER_OPEN =
  '<system-reminder>\nThe material below is available to you while you answer the user.\n\n'

const USER_CONTEXT_REMINDER_CLOSE =
  'IMPORTANT: this material may or may not bear on the task; do not answer it in its own right unless it is highly relevant.\n</system-reminder>'

/** The reminder body for a context, or null for an empty context (nothing rides). */
export function userContextReminderBody(context: Record<string, string>): string | null {
  const entries = Object.entries(context)
  if (entries.length === 0) return null
  const rendered = entries.map(([key, value]) => `# ${key}\n${value}`).join('\n\n')
  return `${USER_CONTEXT_REMINDER_OPEN}${rendered}\n\n${USER_CONTEXT_REMINDER_CLOSE}`
}
