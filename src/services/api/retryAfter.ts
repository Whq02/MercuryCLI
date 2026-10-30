
export function headerValue(headers: unknown, name: string): string | undefined {
  if (headers === undefined || headers === null) return undefined
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined
  }
  const record = headers as Record<string, string>
  const direct = record[name] ?? record[name.toLowerCase()]
  if (direct !== undefined) return direct
  const wanted = name.toLowerCase()
  const key = Object.keys(record).find(k => k.toLowerCase() === wanted)
  return key === undefined ? undefined : record[key]
}

export function errorHeaders(error: unknown): unknown {
  return (error as { headers?: unknown } | null)?.headers
}

export function retryAfterOf(error: unknown): string | undefined {
  const headers = errorHeaders(error)
  const askedMs = positiveMilliseconds(headerValue(headers, 'retry-after-ms'))
  if (askedMs !== undefined) return String(askedMs / 1000)
  return headerValue(headers, 'retry-after')
}

function positiveMilliseconds(header: unknown): number | undefined {
  if (typeof header !== 'string') return undefined
  const text = header.trim()
  if (text === '') return undefined
  const ms = Number(text)
  return Number.isFinite(ms) && Math.round(ms) > 0 ? ms : undefined
}

export function retryAfterHeaderMs(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (header === undefined || header === null) return undefined
  const text = String(header).trim()
  if (text === '') return undefined
  const seconds = Number(text)
  if (Number.isFinite(seconds)) {
    const ms = Math.round(seconds * 1000)
    return ms > 0 ? ms : undefined
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return undefined
  return at > nowMs ? at - nowMs : undefined
}

export function retryAfterSaysNow(header: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (header === undefined || header === null) return false
  const text = String(header).trim()
  if (text === '') return false
  const seconds = Number(text)
  if (Number.isFinite(seconds)) return seconds === 0
  const at = Date.parse(text)
  return Number.isFinite(at) && at <= nowMs
}
function rateLimitResetDelayMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value?.trim()) return undefined
  const text = value.trim()
  const numeric = Number(text)
  if (Number.isFinite(numeric)) {
    const ms = numeric > 1e12 ? numeric - nowMs : numeric > 1e9 ? numeric * 1000 - nowMs : numeric * 1000
    return ms > 0 ? ms : undefined
  }
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/.test(text)) return undefined
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
  const ms = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)].reduce((sum, part) => sum + Number(part[1]) * units[part[2]!]!, 0)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

export function compatRetryHeaderMs(headers: { get(name: string): string | null } | undefined, includeResets = true): number | undefined {
  const explicit = headers?.get('retry-after')
  if (retryAfterSaysNow(explicit)) return 0
  const wait = retryAfterHeaderMs(explicit) ?? positiveMilliseconds(headers?.get('retry-after-ms'))
  if (wait !== undefined || !includeResets) return wait
  const resets = ['requests', 'tokens'].flatMap(bucket => {
    const remaining = headers?.get(`x-ratelimit-remaining-${bucket}`)
    if (remaining !== null && remaining !== undefined && remaining.trim() !== '' && Number(remaining) > 0) return []
    const delay = rateLimitResetDelayMs(headers?.get(`x-ratelimit-reset-${bucket}`))
    return delay === undefined ? [] : [delay]
  })
  return resets.length > 0 ? Math.max(...resets) : rateLimitResetDelayMs(headers?.get('x-ratelimit-reset'))
}
