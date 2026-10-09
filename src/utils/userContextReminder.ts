
export const INSTRUCTIONS_CONTEXT_KEY = 'instructions'

export const USER_CONTEXT_REMINDER_OPEN = '<system-reminder>\n'

const USER_CONTEXT_REMINDER_CLOSE = '\n</system-reminder>'

export function userContextReminderBody(context: Record<string, string>): string | null {
  const entries = Object.entries(context)
  if (entries.length === 0) return null
  const rendered = entries.map(([key, value]) => `# ${key}\n${value}`).join('\n\n')
  return `${USER_CONTEXT_REMINDER_OPEN}${rendered}${USER_CONTEXT_REMINDER_CLOSE}`
}
