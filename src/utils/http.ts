import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from './auth.js'
import { getWorkload } from './workloadContext.js'


export function getUserAgent(): string {
  return getProductUserAgent()
}

export function getProductUserAgent(): string {
  const parts: string[] = []
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  if (entrypoint) parts.push(entrypoint)
  if (process.env.MERCURY_HOST_VERSION) {
    parts.push(`host/${process.env.MERCURY_HOST_VERSION}`)
  }
  if (process.env.MERCURY_HOST_CLIENT_APP) {
    parts.push(`host-app/${process.env.MERCURY_HOST_CLIENT_APP}`)
  }
  const workload = getWorkload()
  if (workload) {
    parts.push(`workload/${workload}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `mercury/${MACRO.VERSION}${suffix}`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  const entrypoint = process.env.MERCURY_ENTRYPOINT
  if (entrypoint) parts.push(entrypoint)
  if (process.env.MERCURY_HOST_VERSION) {
    parts.push(`host/${process.env.MERCURY_HOST_VERSION}`)
  }
  if (process.env.MERCURY_HOST_CLIENT_APP) {
    parts.push(`host-app/${process.env.MERCURY_HOST_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `mercury/${MACRO.VERSION}${suffix}`
}

export function getWebFetchUserAgent(): string {
  return `Mozilla/5.0 (compatible; Mercury/${MACRO.VERSION})`
}


export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

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
