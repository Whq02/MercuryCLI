import { detectSecrets } from './detectSecrets.js'

const SECRET_HEADER_NAME = /authorization|cookie|token|secret|key|password|credential/i
const REDACTED = '[redacted]'

export function describeHeadersRedacted(headers: Record<string, string> | undefined): string {
  const entries = Object.entries(headers ?? {})
  if (entries.length === 0) return '(none)'
  return entries
    .map(([name, value]) => {
      const masked = SECRET_HEADER_NAME.test(name) || detectSecrets(value).length > 0
      return `${name}: ${masked ? REDACTED : value}`
    })
    .join(', ')
}

export function describeEnvRedacted(env: Record<string, string> | undefined): string[] {
  return Object.keys(env ?? {}).map(name => `${name}=${REDACTED}`)
}

export function describeUrlRedacted(url: string): string {
  return url
    .replace(/^(\s*(?:(?:[a-z][a-z\d+.-]*:)?\/\/)?)([^/?#]*)/i, (match, start: string, authority: string) => {
      const at = authority.lastIndexOf('@')
      return at < 0 ? match : `${start}${REDACTED}${authority.slice(at)}`
    })
    .replace(/^([^?#]*\?)([^#]*)/, (_match, start: string, query: string) =>
      start + query.split('&').map(part => {
        const equals = part.indexOf('=')
        return equals < 0 ? part : `${part.slice(0, equals + 1)}${REDACTED}`
      }).join('&'),
    )
}
