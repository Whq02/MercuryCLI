
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
  return headerValue(errorHeaders(error), 'retry-after')
}

export function retryAfterHeaderMs(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (header === undefined || header === null) return undefined
  const text = String(header).trim()
  if (text === '') return undefined
  const seconds = Number(text)
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return undefined
  return at > nowMs ? at - nowMs : undefined
}
