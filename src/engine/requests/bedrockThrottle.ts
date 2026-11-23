import { headerValue } from './retryAfter.js'

export function isBedrockThrottle(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  if (record.status !== undefined && record.status !== 400 && record.status !== 429) return false
  const nested = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined
  const values = [record.message, record.name, record.code, record.__type, nested?.message, nested?.type, nested?.code, nested?.__type, headerValue(record.headers, 'x-amzn-errortype')]
  return values.some(value => typeof value === 'string' && (/\btoo many tokens(?: per day)?,\s*please wait\b/i.test(value) || /(?:^|[^\w])ThrottlingException(?:$|[^\w])/i.test(value)))
}
