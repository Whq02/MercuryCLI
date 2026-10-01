const TEMPORARY_CODES: ReadonlySet<string> = new Set([
  'rate_limit_exceeded', 'server_error', 'service_unavailable', 'overloaded',
  'provider_overloaded', 'provider_unavailable', 'server', 'timeout',
  'network_error', 'insufficient_system_resource',
])
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'authentication', 'authentication_error', 'invalid_api_key', 'invalid_authentication',
  'permission_denied', 'permission_error', 'forbidden', 'unauthorized',
  'payment_required', 'billing_error', 'insufficient_credits', 'insufficient_quota',
  'quota_exceeded', 'quota_exhausted', 'billing_hard_limit_reached',
  'invalid_request', 'invalid_request_error', 'invalid_prompt', 'context_length_exceeded',
  'max_tokens_exceeded', 'token_limit_exceeded', 'string_too_long', 'not_found',
  'precondition_failed', 'payload_too_large', 'unprocessable',
  'content_policy_violation', 'content_filter', 'refusal', 'sensitive',
])
const PERMANENT_CODE_FAMILY = /(?:^|_)(?:auth|authentication|unauthenticated|unauthorized|forbidden|permission|billing|payment|quota|credits?|invalid_request|invalid_prompt|content_policy|content_filter|safety)(?:_|$)/
const PERMANENT_WORDS = /\b(?:authenticat(?:ion|e|ed)|unauthorized|forbidden|permission denied|invalid credentials?|invalid (?:api[ -]?)?key|(?:invalid|expired|revoked) (?:access )?token|billing|payment required|insufficient (?:credits?|quota|balance|funds)|(?:credits?|quota|balance|funds) (?:exhausted|exceeded|depleted)|(?:invalid|malformed|bad) (?:request|prompt)|content (?:policy|filter)|safety (?:policy|filter)|policy violation)\b/i
const TEMPORARY_WORDS = [
  /\bat capacity\b/i,
  /\btry again later\b/i,
  /\btemporarily unavailable\b/i,
  /\boverloaded\b/i,
  /\bnetwork error\b/i,
  /\binternal (?:server )?error\b/i,
]

export function isTemporaryStreamError(error: { code?: unknown; type?: unknown; error_type?: unknown; message?: unknown; status?: number }): boolean {
  const words = [error.code, error.type, error.error_type].filter((word): word is string => typeof word === 'string').map(word => word.toLowerCase())
  const message = typeof error.message === 'string' ? error.message : ''
  const status = error.status ?? (typeof error.code === 'number' ? error.code : undefined)
  if (words.some(word => PERMANENT_CODES.has(word) || PERMANENT_CODE_FAMILY.test(word)) || PERMANENT_WORDS.test(message)) return false
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  return words.some(word => TEMPORARY_CODES.has(word))
    || status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)
    || TEMPORARY_WORDS.some(pattern => pattern.test(message))
}

export function isTemporaryStreamFault(fault: { retryable: boolean; inStream?: true }): boolean {
  return fault.retryable && fault.inStream === true
}
