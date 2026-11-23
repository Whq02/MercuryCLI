import type { ContentBlockParam } from './wire.js'

export function joinBatchedContent(
  values: Array<string | ContentBlockParam[]>,
): string | ContentBlockParam[] {
  if (values.length === 1) return values[0]!
  const strings = values.filter((v): v is string => typeof v === 'string')
  if (strings.length === values.length) return strings.join('\n')
  return values.flatMap(v => (typeof v === 'string' ? [{ type: 'text' as const, text: v }] : v))
}
