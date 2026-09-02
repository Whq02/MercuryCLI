function normalizeRequestIdKey(record: Record<string, unknown>): void {
  if ('requestId' in record && !('request_id' in record)) {
    record.request_id = record.requestId
    delete record.requestId
  }
}

export function normalizeControlMessageKeys(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj
  const record = obj as Record<string, unknown>
  normalizeRequestIdKey(record)
  const response = record.response
  if (typeof response === 'object' && response !== null) {
    normalizeRequestIdKey(response as Record<string, unknown>)
  }
  return obj
}
