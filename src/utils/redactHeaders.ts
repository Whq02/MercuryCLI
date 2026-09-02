import { detectSecrets } from '../memdir/experienceCards.js'

/**
 * Spelling a headers object onto ANY surface (a log line, a CLI
 * confirmation, an error tail) must never ship credential bytes. Names
 * ride — the diagnostic value is WHICH headers exist — while values mask
 * on either bar: a credential-named header, or a value the secret
 * detector flags regardless of name.
 */
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
