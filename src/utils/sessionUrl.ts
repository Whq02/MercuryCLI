const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_SEGMENT = /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i

type ParsedSessionUrl = {
  sessionId?: string
  jsonlFile?: string
}

export function parseSessionIdentifier(resumeIdentifier: string): ParsedSessionUrl | null {
  const trimmed = resumeIdentifier.trim()
  if (trimmed.length === 0) return null
  if (UUID_EXACT.test(trimmed)) {
    return { sessionId: trimmed }
  }
  if (trimmed.endsWith('.jsonl') && trimmed.length > 6 && !trimmed.endsWith('/.jsonl') && !trimmed.endsWith('\\.jsonl')) {
    return { jsonlFile: trimmed }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      const match = UUID_SEGMENT.exec(parsed.pathname)
      if (match?.[1]) {
        return { sessionId: match[1] }
      }
    } catch {
      return null
    }
  }
  return null
}
