/**
 * User agents, auth headers, and the OAuth-401 retry wrapper.
 *
 * The user-agent surface is uniform: every Mercury connection presents the
 * product identity (`mercury/<version>`), and the web-fetch agent presents
 * `Mozilla/5.0 (compatible; Mercury/<version>)` — the version and nothing
 * else. Borrowed vendor agent spellings are retired — providers
 * content-negotiate on them (OpenRouter answers `claude-cli/*` agents a
 * compatibility model view instead of its catalogue), and provider-side
 * client identification rides auth material and app headers, not this
 * string.
 */
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
} from './auth.js'
import { getWorkload } from './workloadContext.js'
import { isRevokedSignInText } from '../services/providers/credentialWall.js'

// ---------------------------------------------------------------------------
// User agents
// ---------------------------------------------------------------------------

/**
 * The provider-API agent: the product identity on every wire. Kept as the
 * one name the transports import; the spelling law lives in
 * getProductUserAgent.
 */
export function getUserAgent(): string {
  return getProductUserAgent()
}

/**
 * The product-true provider-API agent. The parenthesised tail is, in
 * order: the entrypoint (when set), then optional `agent-sdk/…`,
 * `client-app/…` and `workload/…` segments; the workload tag is
 * turn-scoped, so this is recomputed per request rather than cached.
 * Vendors that content-negotiate on borrowed agent spellings (OpenRouter
 * answers `claude-cli/*` a compatibility model view instead of its
 * catalogue) see Mercury as itself.
 */
export function getProductUserAgent(): string {
  const parts: string[] = []
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  if (entrypoint) parts.push(entrypoint)
  if (process.env.MERCURY_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.MERCURY_SDK_VERSION}`)
  }
  if (process.env.MERCURY_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.MERCURY_SDK_CLIENT_APP}`)
  }
  const workload = getWorkload()
  if (workload) {
    parts.push(`workload/${workload}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `mercury/${MACRO.VERSION}${suffix}`
}

/** The product's own identity for MCP connections. */
export function getMCPUserAgent(): string {
  const parts: string[] = []
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  if (entrypoint) parts.push(entrypoint)
  if (process.env.MERCURY_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.MERCURY_SDK_VERSION}`)
  }
  if (process.env.MERCURY_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.MERCURY_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `mercury/${MACRO.VERSION}${suffix}`
}

/** The web-fetch agent. Version only, by the no-disclosure ruling (the
 *  search-UA law extended here): no URL, repo name or operator identity
 *  rides an outbound header — a public homepage may be appended when one
 *  exists. The product presents itself. */
export function getWebFetchUserAgent(): string {
  return `Mozilla/5.0 (compatible; Mercury/${MACRO.VERSION})`
}

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * Subscribers: bearer authorization plus the OAuth beta header (or an error
 * when no access token exists). Everyone else: the API key header (or an
 * error when no key exists).
 */
export function getAuthHeaders(): AuthHeaders {
  if (isClaudeAISubscriber()) {
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens?.accessToken) {
      return { headers: {}, error: 'No OAuth access token available' }
    }
    return {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    }
  }
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return { headers: {}, error: 'No API key available' }
  }
  return { headers: { 'x-api-key': apiKey } }
}

// ---------------------------------------------------------------------------
// OAuth-401 retry
// ---------------------------------------------------------------------------

// The revoked-token wording is read through the credential wall's one
// phrase family (isRevokedSignInText) — never a spelling of this file's own.

function isHttpClientError(error: unknown): error is {
  isAxiosError: true
  response?: { status?: number; data?: unknown }
} {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { isAxiosError?: unknown }).isAxiosError === true
  )
}

/**
 * Wrap a request thunk with one OAuth-refresh retry on 401 (and, when the
 * caller opts in, on a 403 whose body carries the revocation phrase). The
 * thunk must re-read auth headers itself; the retry's outcome is returned or
 * thrown as-is — there is no second recovery.
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  opts?: { also403Revoked?: boolean },
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    if (!isHttpClientError(error)) throw error
    const status = error.response?.status
    const is401 = status === 401
    const isRevoked403 =
      opts?.also403Revoked === true &&
      status === 403 &&
      typeof error.response?.data === 'string' &&
      isRevokedSignInText(error.response.data)
    if (!is401 && !isRevoked403) throw error
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens?.accessToken) throw error
    await handleOAuth401Error(tokens.accessToken)
    return await request()
  }
}
