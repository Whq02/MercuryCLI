
export const USER_CONTEXT_REMINDER_OPEN =
  '<system-reminder>\nThe material below is available to you while you answer the user.\n\n'

const USER_CONTEXT_REMINDER_CLOSE =
  'IMPORTANT: this material may or may not bear on the task; do not answer it in its own right unless it is highly relevant.\n</system-reminder>'

export function userContextReminderBody(context: Record<string, string>): string | null {
  const entries = Object.entries(context)
  if (entries.length === 0) return null
  const rendered = entries.map(([key, value]) => `# ${key}\n${value}`).join('\n\n')
  return `${USER_CONTEXT_REMINDER_OPEN}${rendered}\n\n${USER_CONTEXT_REMINDER_CLOSE}`
}
