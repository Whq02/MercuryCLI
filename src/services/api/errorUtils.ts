import { APIError } from '@anthropic-ai/sdk'

/**
 * Cause-chain walking, SSL/TLS classification, HTML-error-page sanitisation,
 * and human-readable API error formatting.
 */

export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/** The exact OpenSSL/Node TLS codes Node/Bun surface — contract data. */
const SSL_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

const MAX_CAUSE_LINKS = 5

/**
 * Walk an error's `cause` chain for the first Error carrying a string
 * `code`. Examines at most five links (the error itself plus four causes),
 * stopping early on a non-Error link, a link with no cause, or a
 * self-referential cause. A non-object input returns null immediately.
 */
export function extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | null {
  if (typeof error !== 'object' || error === null) return null
  let current: unknown = error
  for (let link = 0; link < MAX_CAUSE_LINKS; link++) {
    if (!(current instanceof Error)) return null
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') {
      return {
        code,
        message: current.message,
        isSSLError: SSL_ERROR_CODES.has(code),
      }
    }
    const cause = (current as { cause?: unknown }).cause
    if (cause === undefined || cause === null) return null
    if (cause === current) return null
    current = cause
  }
  return null
}

/**
 * A hint for contexts the main formatter does not cover (OAuth token
 * exchange, preflight connectivity). Text only for SSL errors; null
 * otherwise.
 */
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) return null
  return (
    `TLS certificate error (${details.code}). This usually means a corporate proxy or ` +
    `TLS-intercepting firewall is rewriting the connection. Fixes: point NODE_EXTRA_CA_CERTS ` +
    `at your organisation's CA bundle, or ask IT to allow-list the API domain. Run /health for details.`
  )
}

/**
 * Error text containing an HTML document (a CDN/edge error page) is replaced
 * by the document title, trimmed — or an empty string when there is no
 * title. Non-HTML text passes through unchanged; a missing message yields an
 * empty string.
 */
export function sanitizeAPIError(apiError: string | undefined | null): string {
  if (apiError === undefined || apiError === null) return ''
  const lower = apiError.toLowerCase()
  if (!lower.includes('<!doctype') && !lower.includes('<html')) return apiError
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(apiError)
  return title?.[1]?.trim() ?? ''
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof APIError && typeof error.status === 'number') return error.status
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/** Recover a nested message from persisted body shapes; deeper level first. */
function recoverNestedMessage(error: unknown): string | undefined {
  const outer = (error as { error?: unknown } | null)?.error as
    | { error?: { message?: unknown }; message?: unknown }
    | undefined
  // The first-party API response shape: outer key is the body, inner is the
  // API error.
  const deep = outer?.error?.message
  if (typeof deep === 'string') {
    const sanitized = sanitizeAPIError(deep)
    if (sanitized !== '') return sanitized
  }
  // The gateway shape.
  const shallow = outer?.message
  if (typeof shallow === 'string') {
    const sanitized = sanitizeAPIError(shallow)
    if (sanitized !== '') return sanitized
  }
  return undefined
}

/** Decode the human message out of a raw JSON error blob embedded in
 *  terminal error TEXT (the remainder the transcript's error card folds).
 *  Tolerates a non-JSON tail after the object (request-id suffixes) by
 *  retrying at the last closing brace. Undefined when nothing decodes. */
export function decodeApiErrorBlobMessage(blob: string): string | undefined {
  const parse = (raw: string): unknown => {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  let parsed = parse(blob)
  if (parsed === undefined) {
    const end = blob.lastIndexOf('}')
    if (end !== -1) parsed = parse(blob.slice(0, end + 1))
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return recoverNestedMessage({ error: parsed })
}

function sslErrorText(code: string): string {
  switch (code) {
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return `Certificate verification failed (${code}). Check your proxy or corporate certificates.`
    case 'CERT_HAS_EXPIRED':
      return 'The server presented an expired certificate. Check your system clock, proxy, or corporate certificates.'
    case 'CERT_REVOKED':
      return 'The server presented a revoked certificate.'
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `Self-signed certificate detected (${code}). Check your proxy or corporate certificates.`
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'HOSTNAME_MISMATCH':
      return 'Certificate hostname mismatch. The certificate does not match the host being contacted.'
    case 'CERT_NOT_YET_VALID':
      return 'The server presented a certificate that is not yet valid. Check your system clock.'
    default:
      return `SSL error (${code}).`
  }
}

/**
 * Human-readable API error formatting. Callers index into the returned
 * string, so this never returns undefined.
 */
export function formatAPIError(error: unknown): string {
  const details = extractConnectionErrorDetails(error)
  if (details !== null) {
    if (details.code === 'ETIMEDOUT') {
      return 'The request timed out. Check your internet connection and proxy settings.'
    }
    if (details.isSSLError) {
      return sslErrorText(details.code)
    }
    // Other connection codes deliberately fall through: the generic
    // connection-error step below can name them.
  }

  const message = (error as { message?: unknown } | null)?.message
  // Equality, not substring — the SDK emits exactly this string.
  if (message === 'Connection error.') {
    if (details !== null) {
      return `Connection failed (${details.code}). Check your internet connection and proxy settings.`
    }
    return 'Connection failed. Check your internet connection.'
  }

  if (typeof message !== 'string' || message === '') {
    // Errors round-tripped through session JSONL lose the SDK class's
    // .message; recover from the persisted body shapes, deeper first.
    const recovered = recoverNestedMessage(error)
    if (recovered !== undefined) return recovered
    const status = statusOf(error)
    return `API error (status ${status ?? 'unknown'})`
  }

  const sanitized = sanitizeAPIError(message)
  if (sanitized !== message && sanitized !== '') return sanitized
  return message
}
