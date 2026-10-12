import { extractTag } from './messages.js'

const REASON_MAX_CHARS = 200

export function toolErrorReason(result: string, fallback: string): string {
  const inner = extractTag(result, 'tool_use_error') ?? result
  const line = inner.split('\n').map(part => part.trim()).find(part => part !== '') ?? ''
  if (line === '') return fallback
  const cut = line.search(/[.;](\s|$)/)
  const clause = cut === -1 ? line : line.slice(0, cut + (line[cut] === '.' ? 1 : 0))
  return clause.length > REASON_MAX_CHARS ? `${clause.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…` : clause
}
