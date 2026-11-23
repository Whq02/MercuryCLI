import { randomUUID } from 'node:crypto'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { recordTransportFailure } from '../../utils/api/transportEvidence.js'
import {
  getAnthropicApiKey,
  getAnthropicApiKeyWorkspaceId,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { apiTimeoutMsOverride } from '../../utils/envValidation.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { getUserAgent } from '../../utils/http.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { passedOver } from '../../utils/passedOver.js'
import { getApiFetch, getProxyFetchOptions } from '../../utils/proxy.js'
import { checkAndRefreshOAuthTokenIfNeeded } from '../auth/oauthLifecycle.js'
import {
  AnthropicClient as Anthropic,
  type AnthropicClientOptions,
} from '../providers/anthropic/anthropicClient.js'
import {
  observeStreamActivity,
  streamActivityNoteOf,
} from '../providers/streamIdleBudget.js'
import { wrapFetchWithWireDump } from './dumpPrompts.js'

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

type GetClientOptions = {
  apiKey?: string
  workspaceId?: string
  maxRetries: number
  fetchOverride?: typeof globalThis.fetch
  source?: string
}

type SdkLogger = {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

function parseProviderHeaders(raw: string | undefined): Record<string, string> {
  const parsed: Record<string, string> = {}
  if (!raw) return parsed
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    if (name === '') continue
    const value = line.slice(colon + 1).trim()
    parsed[name] = value
  }
  return parsed
}

function buildWrappedFetch(
  fetchOverride: typeof globalThis.fetch | undefined,
  source: string | undefined,
): typeof globalThis.fetch {
  const baseFetch = fetchOverride ?? wrapFetchWithWireDump(getApiFetch(), source)
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    try {
      let correlationId = headers.get(CLIENT_REQUEST_ID_HEADER)
      if (!correlationId && isFirstPartyAnthropicBaseUrl()) {
        correlationId = randomUUID()
        headers.set(CLIENT_REQUEST_ID_HEADER, correlationId)
      }
      let pathLabel = rawUrl
      try {
        pathLabel = new URL(rawUrl).pathname
      } catch (error) {
        passedOver(error)
      }
      const idPart = correlationId ? ` (${CLIENT_REQUEST_ID_HEADER}: ${correlationId})` : ''
      const sourcePart = source ? ` [source: ${source}]` : ''
      logForDebugging(`API request ${pathLabel}${idPart}${sourcePart}`)
    } catch (error) {
      passedOver(error)
    }

    try {
      const response = await baseFetch(input, { ...init, headers })
      const activityNote = streamActivityNoteOf(init)
      return activityNote ? observeStreamActivity(response, activityNote) : response
    } catch (error) {
      try {
        recordTransportFailure(error, rawUrl)
      } catch (recordError) {
        passedOver(recordError)
      }
      throw error
    }
  }
}

export async function getAnthropicClient(options: GetClientOptions): Promise<Anthropic> {
  const rawProviderHeaders = flagEnv('MERCURY_PROVIDER_HEADERS')
  const providerHeaders = parseProviderHeaders(rawProviderHeaders)
  const providerHeadersPresent = Boolean(rawProviderHeaders)
  const carriesAuthorization =
    providerHeadersPresent && Object.hasOwn(providerHeaders, 'Authorization')
  logForDebugging(
    `client: MERCURY_PROVIDER_HEADERS ${providerHeadersPresent ? 'present' : 'absent'}${carriesAuthorization ? ' (carries Authorization)' : ''}`,
  )

  const defaultHeaders: Record<string, string> = {
    'x-app': 'cli',
    'User-Agent': getUserAgent(),
    'X-Claude-Code-Session-Id': String(getSessionId()),
    ...providerHeaders,
  }

  const hostClientApp = flagEnv('MERCURY_HOST_CLIENT_APP')
  if (hostClientApp) {
    defaultHeaders['x-client-app'] = hostClientApp
  }

  if (isEnvTruthy(flagEnv('MERCURY_ADDITIONAL_PROTECTION'))) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  const timeout = apiTimeoutMsOverride() ?? 600_000

  logForDebugging('client: auth step starting')
  await checkAndRefreshOAuthTokenIfNeeded()

  const hasExplicitKey = options.apiKey !== undefined
  const isSubscriber = !hasExplicitKey && isClaudeAISubscriber()
  const subscriberToken = isSubscriber ? (getClaudeAIOAuthTokens()?.accessToken ?? null) : null
  const envAuthToken = hostEnv().ANTHROPIC_AUTH_TOKEN

  if (!isSubscriber && !hasExplicitKey) {
    const bearerToken =
      envAuthToken && envAuthToken.length > 0
        ? envAuthToken
        : await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    if (bearerToken) {
      defaultHeaders['Authorization'] = `Bearer ${bearerToken}`
    }
  }

  const apiKey = isSubscriber ? null : (options.apiKey ?? getAnthropicApiKey())
  const workspaceId =
    options.workspaceId ??
    (!hasExplicitKey && apiKey ? getAnthropicApiKeyWorkspaceId(apiKey) : undefined)
  if (workspaceId) {
    defaultHeaders['anthropic-workspace-id'] = workspaceId
  }

  if (hasExplicitKey) {
    for (const key of Object.keys(defaultHeaders)) {
      const lower = key.toLowerCase()
      if (lower === 'authorization' || lower === 'x-api-key') {
        delete defaultHeaders[key]
      }
    }
  }

  const authToken = isSubscriber
    ? subscriberToken
    : hasExplicitKey
      ? null
      : envAuthToken || null

  logForDebugging('client: auth step complete')

  const logger: SdkLogger | undefined = isDebugToStdErr()
    ? {
        error: (...args: unknown[]) => console.error('[SDK error]', ...args),
        warn: (...args: unknown[]) => console.error('[SDK warn]', ...args),
        info: (...args: unknown[]) => console.error('[SDK info]', ...args),
        debug: (...args: unknown[]) => console.error('[SDK debug]', ...args),
      }
    : undefined

  const clientOptions: AnthropicClientOptions & { logger?: SdkLogger } = {
    defaultHeaders,
    maxRetries: options.maxRetries,
    timeout,
    dangerouslyAllowBrowser: true,
    fetch: buildWrappedFetch(options.fetchOverride, options.source),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: true }),
    apiKey,
    authToken,
    subscriptionAuth: isSubscriber,
    ...(logger !== undefined ? { logger } : {}),
  }

  return new Anthropic(clientOptions)
}
