import type { ToolResultBlockParam } from '../../types/wire.js'
import { flagEnv } from '../../substrate/flagRegistry.js'


export const MC_CLEARED_PLACEHOLDER = '[stale tool result pruned — content cleared]'

export const MC_DIGEST_PREFIX = '[stale tool result · digest:'

const LEGACY_MC_CLEARED_PLACEHOLDER = '[Old tool result content cleared]'
const LEGACY_MC_DIGEST_PREFIX = '[Old tool result · digest:'

type ContentClass =
  | 'text'
  | 'file-listing'
  | 'json/structured'
  | 'diff'
  | 'log/stacktrace'
  | 'error'
  | 'log'
  | 'tabular'

type DigestableContent = ToolResultBlockParam['content'] | undefined

export function isMicroCompactDigestEnabled(): boolean {
  if (flagEnv('MERCURY_MC_DIGEST') === '0') return false
  return true
}

export function isClearedOrDigested(content: DigestableContent): boolean {
  return (
    typeof content === 'string' &&
    (content === MC_CLEARED_PLACEHOLDER ||
      content === LEGACY_MC_CLEARED_PLACEHOLDER ||
      content.startsWith(MC_DIGEST_PREFIX) ||
      content.startsWith(LEGACY_MC_DIGEST_PREFIX))
  )
}

function extractText(content: DigestableContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(item =>
      item && typeof item === 'object' && (item as { type?: string }).type === 'text'
        ? ((item as { text?: string }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

const PRED = {
  pathLike: (l: string) => /^[./~]?[\w.@-]+(?:\/[\w.@-]*)+$/.test(l),
  jsonStruct: (l: string) => /^[[{]|[\]}],?$/.test(l) || /"[\w-]+"\s*:/.test(l),
  diffLike: (l: string) => /^(?:[+\-@]|diff --git\b)/.test(l),
  errLike: (l: string) => /\b(?:Error|Exception|Traceback|FAILED?|panic|fatal)\b/i.test(l),
  stackLike: (l: string) =>
    /\bat\s+\S.*\(.*:\d+\)/.test(l) || /File ".*", line \d+/.test(l) || /:\d+:\d+/.test(l),
  tabular: (l: string) => /\t/.test(l) || /\S {2,}\S.* {2,}\S/.test(l),
  logLike: (l: string) =>
    /^\d{4}-\d\d-\d\d[T ]/.test(l) || /^\[\w+\]/.test(l) || /^\d\d:\d\d:\d\d/.test(l),
}

function classify(text: string): ContentClass {
  const nonEmpty = text.split('\n').filter(l => l.trim().length > 0)
  const n = nonEmpty.length
  if (n === 0) return 'text'
  const c = { pathLike: 0, jsonStruct: 0, diffLike: 0, errLike: 0, stackLike: 0, tabular: 0, logLike: 0 }
  let brackets = 0
  for (const raw of nonEmpty) {
    const l = raw.trim()
    if (PRED.pathLike(l)) c.pathLike++
    if (PRED.jsonStruct(l)) c.jsonStruct++
    if (PRED.diffLike(l)) c.diffLike++
    if (PRED.errLike(l)) c.errLike++
    if (PRED.stackLike(l)) c.stackLike++
    if (PRED.tabular(raw)) c.tabular++
    if (PRED.logLike(l)) c.logLike++
  }
  for (const ch of text) if (ch === '{' || ch === '}' || ch === '[' || ch === ']') brackets++
  const r = (x: number) => x / n
  const bracketDensity = text.length > 0 ? brackets / text.length : 0
  if ((r(c.errLike) > 0 && r(c.stackLike) > 0) || r(c.stackLike) >= 0.3) return 'log/stacktrace'
  if (r(c.diffLike) >= 0.4) return 'diff'
  if (r(c.jsonStruct) >= 0.3 || bracketDensity >= 0.08) return 'json/structured'
  if (r(c.pathLike) >= 0.6) return 'file-listing'
  if (r(c.errLike) >= 0.25) return 'error'
  if (r(c.logLike) >= 0.4) return 'log'
  if (r(c.tabular) >= 0.5) return 'tabular'
  return 'text'
}

export function digestClearedToolResult(content: DigestableContent): string {
  if (!isMicroCompactDigestEnabled()) return MC_CLEARED_PLACEHOLDER
  if (isClearedOrDigested(content)) {
    return typeof content === 'string' ? content : MC_CLEARED_PLACEHOLDER
  }
  const text = extractText(content)
  if (!text.trim()) return MC_CLEARED_PLACEHOLDER

  const lineCount = text.split('\n').length
  const approxTokens = Math.round(text.length / 4 / 10) * 10
  const cls = classify(text)
  return `${MC_DIGEST_PREFIX} ${lineCount} lines, ~${approxTokens} tok, ${cls}]`
}
