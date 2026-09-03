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
import { wrapFetchWithWireDump } from './dumpPrompts.js'
import { recordTransportFailure } from './transportEvidence.js'


export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

const DEFAULT_API_TIMEOUT_MS = 600_000

type GetClientOptions = {
  apiKey?: string
  maxRetries: number
  fetchOverride?: typeof globalThis.fetch
  source?: string
}

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

function buildFetchWrapper(
  fetchOverride: typeof globalThis.fetch | undefined,
  injectCorrelationId: boolean,
  source: string | undefined,
): typeof globalThis.fetch {
  const baseFetch = wrapFetchWithWireDump(fetchOverride ?? getApiFetch(), source)
  return async (input, init) => {
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
      }
      logForDebugging(
        `API request ${path}${correlationId ? ` (${CLIENT_REQUEST_ID_HEADER}: ${correlationId})` : ''}${source ? ` [source: ${source}]` : ''}`,
      )
    } catch {
    }
    try {
      return await baseFetch(input, { ...init, headers })
    } catch (err) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        recordTransportFailure(err, url)
      } catch {
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

  const injectCorrelationId = isFirstPartyAnthropicBaseUrl()

  const sharedOptions = {
    defaultHeaders,
    maxRetries,
    timeout,
    dangerouslyAllowBrowser: true,
    fetch: buildFetchWrapper(fetchOverride, injectCorrelationId, source),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
  }

  const firstPartyOptions: Record<string, unknown> = {
    ...sharedOptions,
    apiKey: subscriber ? null : (callerApiKey ?? getAnthropicApiKey()),
    ...(subscriber && oauthAccessToken ? { authToken: oauthAccessToken } : {}),
  }
  attachStderrLogger(firstPartyOptions)
  return new Anthropic(firstPartyOptions as never)
}
