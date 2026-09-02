/**
 * Adapter seam: normalise the camelCase request-id key emitted by older
 * first-party mobile builds to the snake_case wire spelling on inbound
 * control messages. Without this, the control-request type guard (which
 * tests for the snake_case key) rejects the message and the structured-IO
 * reader sees an undefined request id — silently dropped on both paths.
 *
 * Mutates in place and returns its input. When both spellings are present
 * the snake_case one wins and the camelCase key is left alone. The same
 * rule is applied one level deeper to a nested `response` object.
 */
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
