import { detectSecrets } from '../memdir/experienceCards.js'

const SECRET_HEADER_NAME = /authorization|cookie|token|secret|key|password|credential/i

export function describeHeadersRedacted(headers: Record<string, string> | undefined): string {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return '(none)'
  return entries
    .map(([name, value]) => {
      const masked = SECRET_HEADER_NAME.test(name) || detectSecrets(value).length > 0
      return `${name}: ${masked ? '[redacted]' : value}`
    })
    .join(', ')
}
