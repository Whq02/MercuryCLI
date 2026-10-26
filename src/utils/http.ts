import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { anthropicApiKeyHeaders, getAnthropicApiKey, getClaudeAIOAuthTokens, isClaudeAISubscriber } from './auth.js'
import { getWorkload } from './workloadContext.js'

const hostSegments = (): string[] =>
  [
    process.env.MERCURY_ENTRYPOINT,
    process.env.MERCURY_HOST_VERSION && `host/${process.env.MERCURY_HOST_VERSION}`,
    process.env.MERCURY_HOST_CLIENT_APP && `host-app/${process.env.MERCURY_HOST_CLIENT_APP}`,
  ].filter((segment): segment is string => Boolean(segment))

function productIdentity(segments: string[]): string {
  const suffix = segments.length > 0 ? ` (${segments.join(', ')})` : ''
  return `mercury/${MACRO.VERSION}${suffix}`
}

export function getProductUserAgent(): string {
  const workload = getWorkload()
  return productIdentity(workload ? [...hostSegments(), `workload/${workload}`] : hostSegments())
}

export function getUserAgent(): string {
  return getProductUserAgent()
}

export function getMCPUserAgent(): string {
  return productIdentity(hostSegments())
}

export { webUserAgent as getWebFetchUserAgent } from './webUserAgent.js'

type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

const refused = (error: string): AuthHeaders => ({ headers: {}, error })

export function getAuthHeaders(): AuthHeaders {
  if (!isClaudeAISubscriber()) {
    const apiKey = getAnthropicApiKey()
    return apiKey ? { headers: anthropicApiKeyHeaders(apiKey) } : refused('No API key available')
  }
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  return accessToken
    ? { headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA_HEADER } }
    : refused('No OAuth access token available')
}
