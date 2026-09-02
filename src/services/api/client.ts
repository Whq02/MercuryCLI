import { randomUUID } from 'node:crypto'

import Anthropic from '@anthropic-ai/sdk'

import { getSessionId } from '../../bootstrap/state.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { apiTimeoutMsOverride } from '../../utils/envValidation.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getUserAgent } from '../../utils/http.js'
import {
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { recordTransportFailure } from './transportEvidence.js'

/**
 * Constructs the first-party Anthropic SDK client, including headers, auth,
 * timeouts, and the fetch wrapper.
 */

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

const DEFAULT_API_TIMEOUT_MS = 600_000

type GetClientOptions = {
  apiKey?: string
  maxRetries: number
  fetchOverride?: typeof globalThis.fetch
  source?: string
}

/**
 * Parse ANTHROPIC_CUSTOM_HEADERS: newline-separated `Name: Value` lines,
 * split on the FIRST colon only, both halves trimmed. Colon-less lines,
 * empty names, and blank lines are skipped. No backtracking regex —
 * malformed long lines are a real input.
 */
function parseCustomHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!raw) return headers
  for (const line of raw.split(/\r\n|\n/)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name === '') continue
    headers[name] = value
  }
  return headers
}

function attachStderrLogger(options: Record<string, unknown>): void {
  if (!isDebugToStdErr()) return
  options.logger = {
    error: (...args: unknown[]) => console.error('[SDK error]', ...args),
    warn: (...args: unknown[]) => console.error('[SDK warn]', ...args),
    info: (...args: unknown[]) => console.error('[SDK info]', ...args),
    debug: (...args: unknown[]) => console.error('[SDK debug]', ...args),
  }
}

/**
 * The fetch wrapper. Whether the correlation header is injected is decided
 * ONCE, when the wrapper is built — a provider or base-URL change only takes
 * effect when a new client is built (the auth-epoch mover forces a
 * rebuild on every move).
 */
function buildFetchWrapper(
  fetchOverride: typeof globalThis.fetch | undefined,
  injectCorrelationId: boolean,
  source: string | undefined,
): typeof globalThis.fetch {
  const baseFetch = fetchOverride ?? getApiFetch()
  return async (input, init) => {
    // Copy the incoming headers into a fresh container and send the copy.
    const headers = new Headers((init as { headers?: HeadersInit } | undefined)?.headers)
    let correlationId: string | undefined
    if (injectCorrelationId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      correlationId = randomUUID()
      headers.set(CLIENT_REQUEST_ID_HEADER, correlationId)
    } else if (headers.has(CLIENT_REQUEST_ID_HEADER)) {
      correlationId = headers.get(CLIENT_REQUEST_ID_HEADER) ?? undefined
    }
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      let path = url
      try {
        path = new URL(url).pathname
      } catch {
        // Keep the raw URL when parsing fails.
      }
      logForDebugging(
        `API request ${path}${correlationId ? ` (${CLIENT_REQUEST_ID_HEADER}: ${correlationId})` : ''}${source ? ` [source: ${source}]` : ''}`,
      )
    } catch {
      // Any failure inside logging is swallowed.
    }
    try {
      return await baseFetch(input, { ...init, headers })
    } catch (err) {
      // Record the transport failure BEFORE rethrowing untouched: the SDK's
      // timeout error class is constructed without the cause, so the
      // low-level code would otherwise be destroyed.
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        recordTransportFailure(err, url)
      } catch {
        // Evidence collection must never alter the thrown error.
      }
      throw err
    }
  }
}

export async function getAnthropicClient(options: GetClientOptions): Promise<Anthropic> {
  const { apiKey: callerApiKey, maxRetries, fetchOverride, source } = options

  const customHeadersRaw = process.env.ANTHROPIC_CUSTOM_HEADERS
  const customHeaders = parseCustomHeaders(customHeadersRaw)
  logForDebugging(
    `client: ANTHROPIC_CUSTOM_HEADERS ${customHeadersRaw ? 'present' : 'absent'}${
      customHeadersRaw && 'Authorization' in customHeaders ? ' (carries Authorization)' : ''
    }`,
  )

  // Custom headers merge OVER the three defaults; everything applied after
  // this point wins over a same-named custom header.
  const defaultHeaders: Record<string, string> = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': getSessionId(),
    ...customHeaders,
  }
  if (process.env.MERCURY_SDK_CLIENT_APP) {
    defaultHeaders['x-client-app'] = process.env.MERCURY_SDK_CLIENT_APP
  }
  if (isEnvTruthy(process.env.MERCURY_ADDITIONAL_PROTECTION)) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  // The ONE parser (envValidation): '60s' is rejected whole, never read
  // as 60ms (TASK-017 S2, api-timeout-ms-three-parsers-no-floor).
  const timeout = apiTimeoutMsOverride() ?? DEFAULT_API_TIMEOUT_MS

  logForDebugging('client: auth step starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  const subscriber = isClaudeAISubscriber()
  const oauthAccessToken = subscriber ? getClaudeAIOAuthTokens()?.accessToken : undefined
  if (!subscriber) {
    const envToken = process.env.ANTHROPIC_AUTH_TOKEN
    const token =
      envToken && envToken !== ''
        ? envToken
        : await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    if (token) {
      defaultHeaders.Authorization = `Bearer ${token}`
    }
  }
  logForDebugging('client: auth step complete')

  // On only for a first-party host: strict proxies have rejected unknown
  // headers.
  const injectCorrelationId = isFirstPartyAnthropicBaseUrl()

  const sharedOptions = {
    defaultHeaders,
    maxRetries,
    timeout,
    dangerouslyAllowBrowser: true,
    fetch: buildFetchWrapper(fetchOverride, injectCorrelationId, source),
    // The transport fetch options (explicit dispatcher / proxy dispatcher /
    // remote-shell unix socket / TLS material). Only the provider API client
    // passes the provider-API flag.
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
  }

  // No auth material at all still constructs (the failure surfaces as a 401).
  const firstPartyOptions: Record<string, unknown> = {
    ...sharedOptions,
    apiKey: subscriber ? null : (callerApiKey ?? getAnthropicApiKey()),
    ...(subscriber && oauthAccessToken ? { authToken: oauthAccessToken } : {}),
  }
  attachStderrLogger(firstPartyOptions)
  return new Anthropic(firstPartyOptions as never)
}
