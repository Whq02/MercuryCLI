import { APIError } from '@anthropic-ai/sdk'

import { addToTotalDurationState } from '../../bootstrap/state.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { classifyAPIError } from './errors.js'
import { EMPTY_USAGE } from './emptyUsage.js'

/**
 * Per-request bookkeeping hooks called by the streaming transports, plus
 * AI-gateway fingerprinting. The telemetry sink was deliberately removed:
 * several values are computed and then discarded. Keep the signatures and
 * the debug/error-log side effects; add no sink.
 */

export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

export { EMPTY_USAGE }
export type { NonNullableUsage }

// ---------------------------------------------------------------------------
// Post-compaction marker + completion timestamp (consumed by the success
// hook; set by the compaction paths / read by idle logic).
// ---------------------------------------------------------------------------

let postCompactionPending = false
let lastApiSuccessAt: number | null = null

/** Set after a compaction completes; consumed by the next success/error hook. */
export function markPostCompaction(): void {
  postCompactionPending = true
}

function consumePostCompactionMarker(): boolean {
  const was = postCompactionPending
  postCompactionPending = false
  return was
}

/** The completion timestamp of the most recent successful request. */
export function getLastApiSuccessTimestamp(): number | null {
  return lastApiSuccessAt
}

// ---------------------------------------------------------------------------
// Gateway fingerprinting
// ---------------------------------------------------------------------------

/** Vendor-documented response-header prefixes, tested in order. */
const GATEWAY_HEADER_PREFIXES: ReadonlyArray<[string, string]> = [
  ['x-litellm-', 'LiteLLM'],
  ['helicone-', 'Helicone'],
  ['x-portkey-', 'Portkey'],
  ['cf-aig-', 'Cloudflare AI Gateway'],
  ['x-kong-', 'Kong'],
  ['x-bt-', 'Braintrust'],
]

const GATEWAY_HOST_SUFFIXES: ReadonlyArray<[string, string]> = [
  ['.cloud.databricks.com', 'Databricks'],
  ['.azuredatabricks.net', 'Databricks'],
  ['.gcp.databricks.com', 'Databricks'],
]

type HeadersLike = Headers | Record<string, string> | undefined

function headerNames(headers: HeadersLike): string[] {
  if (headers === undefined) return []
  if (typeof (headers as Headers).keys === 'function') {
    return [...(headers as Headers).keys()]
  }
  // A plain object's names are taken exactly as-is (no normalisation), so a
  // mixed-case object would not match — deliberate.
  return Object.keys(headers as Record<string, string>)
}

function detectGatewayFromHeaders(headers: HeadersLike): string | undefined {
  const names = headerNames(headers)
  for (const [prefix, vendor] of GATEWAY_HEADER_PREFIXES) {
    if (names.some(name => name.startsWith(prefix))) return vendor
  }
  return undefined
}

function detectGatewayFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    for (const [suffix, vendor] of GATEWAY_HOST_SUFFIXES) {
      if (host.endsWith(suffix)) return vendor
    }
  } catch {
    // A malformed URL is ignored.
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The three hooks
// ---------------------------------------------------------------------------

export type LogAPIQueryParams = {
  model: string
  messagesLength: number
  temperature?: number
  betas?: string[]
  permissionMode?: string
  querySource?: string
  queryTracking?: unknown
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  effortValue?: string | null
  previousRequestId?: string | null
}

/**
 * Called before a request. The body is EMPTY — the analytics sink was
 * removed. The call must remain safe, synchronous, and side-effect-free.
 */
export function logAPIQuery(_params: LogAPIQueryParams): void {
  // Deliberately empty (stripped telemetry).
}

export type LogAPIErrorParams = {
  error: unknown
  model: string
  messageCount: number
  messageTokens?: number
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  requestId?: string | null
  clientRequestId?: string | null
  didFallBackToNonStreaming?: boolean
  promptCategory?: string
  responseHeaders?: HeadersLike
  queryTracking?: unknown
  querySource?: string
  previousRequestId?: string | null
}

export function logAPIError(params: LogAPIErrorParams): void {
  const { error } = params

  // Gateway: the error's own headers when it is an SDK API error, else the
  // supplied headers, else the base URL.
  let gateway: string | undefined
  if (error instanceof APIError) {
    gateway = detectGatewayFromHeaders(error.headers as HeadersLike)
  }
  if (gateway === undefined) gateway = detectGatewayFromHeaders(params.responseHeaders)
  if (gateway === undefined) {
    gateway = detectGatewayFromBaseUrl(process.env.ANTHROPIC_BASE_URL)
  }

  // Extract a human message: SDK API errors prefer the response body's own
  // error object; otherwise the error's message; otherwise the stringified
  // value.
  let extracted: string
  if (error instanceof APIError) {
    const inner = (error as { error?: { error?: { message?: unknown } } }).error?.error?.message
    extracted =
      typeof inner === 'string' ? inner : typeof error.message === 'string' ? error.message : String(error)
  } else if (error instanceof Error) {
    extracted = error.message
  } else {
    extracted = String(error)
  }

  const status = error instanceof APIError ? error.status : undefined
  const errorClass = classifyAPIError(error)
  // The gateway, message, status and class had a telemetry sink that was
  // removed — computed and discarded.
  void gateway
  void extracted
  void status
  void errorClass

  const details = extractConnectionErrorDetails(error)
  if (details !== null) {
    logForDebugging(
      `API connection error: ${details.code}${details.isSSLError ? ' (SSL error)' : ''}: ${details.message}`,
      { level: 'error' },
    )
  }

  // One-shot read on error AND success so the value cannot leak into the
  // next request.
  consumeInvokingRequestId()

  if (params.clientRequestId) {
    logForDebugging(
      `client request id ${params.clientRequestId} — give this to the API team to look up the request in server logs`,
      { level: 'error' },
    )
  }

  logError(error)
}

/**
 * THE API-DURATION LEDGER WRITE (FN-018 rank 11): the time a request spent
 * on the provider — the final attempt (`start`) beside the whole ladder
 * including retries and backoffs (`startIncludingRetries`). One writer for
 * every lane and every outcome: the success path below, the Anthropic
 * stream core's every other exit (an abort, an error after the retry
 * ladder, the consumer's early return — minutes of real API time that were
 * measured and discarded, so duration_api_ms and "Total duration (API)"
 * read 0 for exactly the runs where API time mattered most), and the
 * compat and Z.AI runtimes, which never wrote the ledger at all. A failed
 * turn's API duration is the time the operator waited on the provider for
 * it — what the wall-duration figure beside it already counts.
 */
export function logAPIDuration({
  start,
  startIncludingRetries,
}: {
  start: number
  startIncludingRetries: number
}): void {
  const now = Date.now()
  // Accumulator parameter order: including-retries first, then the attempt
  // duration.
  addToTotalDurationState(now - startIncludingRetries, now - start)
}

export function logAPISuccessAndDuration({
  start,
  startIncludingRetries,
}: {
  start: number
  startIncludingRetries: number
}): void {
  logAPIDuration({ start, startIncludingRetries })
  consumePostCompactionMarker()
  consumeInvokingRequestId()
  lastApiSuccessAt = Date.now()
}
