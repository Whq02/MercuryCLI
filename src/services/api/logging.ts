import { APIError } from '@anthropic-ai/sdk'

import { addToTotalDurationState } from '../../bootstrap/state.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { classifyAPIError } from './errors.js'
import { EMPTY_USAGE } from './emptyUsage.js'


export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

export { EMPTY_USAGE }
export type { NonNullableUsage }


let postCompactionPending = false
let lastApiSuccessAt: number | null = null

export function markPostCompaction(): void {
  postCompactionPending = true
}

function consumePostCompactionMarker(): boolean {
  const was = postCompactionPending
  postCompactionPending = false
  return was
}

export function getLastApiSuccessTimestamp(): number | null {
  return lastApiSuccessAt
}


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
  }
  return undefined
}


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

export function logAPIQuery(_params: LogAPIQueryParams): void {
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

  let gateway: string | undefined
  if (error instanceof APIError) {
    gateway = detectGatewayFromHeaders(error.headers as HeadersLike)
  }
  if (gateway === undefined) gateway = detectGatewayFromHeaders(params.responseHeaders)
  if (gateway === undefined) {
    gateway = detectGatewayFromBaseUrl(process.env.ANTHROPIC_BASE_URL)
  }

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

  consumeInvokingRequestId()

  if (params.clientRequestId) {
    logForDebugging(
      `client request id ${params.clientRequestId} — give this to the API team to look up the request in server logs`,
      { level: 'error' },
    )
  }

  logError(error)
}

export function logAPIDuration({
  start,
  startIncludingRetries,
}: {
  start: number
  startIncludingRetries: number
}): void {
  const now = Date.now()
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
