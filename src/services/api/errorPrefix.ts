export const API_ERROR_MESSAGE_PREFIX = 'API Error'

export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Please run /logins. ${API_ERROR_MESSAGE_PREFIX}`) ||
    text.startsWith(`Please run /logins · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}
