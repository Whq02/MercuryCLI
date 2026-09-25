
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
