export const API_ERROR_MESSAGE_PREFIX = 'API Error'

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith('API Error') ||
    text.startsWith('Run /logins. API Error') ||
    text.startsWith('Please run /logins. API Error') ||
    text.startsWith('Please run /logins · API Error')
  )
}
