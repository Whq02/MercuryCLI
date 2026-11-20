import axios from 'axios'

import { anthropicAccountApiBase } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokens, hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'


export type RateLimit = {
  utilization: number | null
  resets_at: string | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  seven_day_fable?: RateLimit | null
  limits?: Array<{
    kind?: string
    group?: string
    percent?: number | null
    resets_at?: string | null
    scope?: { model?: { display_name?: string | null } | null } | null
  }> | null
  extra_usage?: unknown
  spend?: unknown
}

const USAGE_TIMEOUT_MS = 5000

export function usageEndpointBase(): string {
  return anthropicAccountApiBase()
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) return {}

  const { mockUtilizationPayload } =
    require('../mockRateLimits.js') as typeof import('../mockRateLimits.js')
  const mocked = mockUtilizationPayload()
  if (mocked !== null) {
    const { foldUtilizationFromEndpoint } =
      require('../anthropicLimits.js') as typeof import('../anthropicLimits.js')
    foldUtilizationFromEndpoint(mocked, undefined)
    return mocked
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt ?? null)) return null

  const auth = getAuthHeaders()
  if (auth.error !== undefined) {
    throw new Error(`Failed to build auth headers for usage fetch: ${auth.error}`)
  }

  const { getUsageCredentialEpoch, foldUtilizationFromEndpoint } =
    require('../anthropicLimits.js') as typeof import('../anthropicLimits.js')
  const issuedEpoch = getUsageCredentialEpoch()

  const base = usageEndpointBase()
  const response = await axios.get<Utilization>(`${base}/api/oauth/usage`, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getAnthropicClientUserAgent(),
      ...auth.headers,
    },
    timeout: USAGE_TIMEOUT_MS,
  })
  const data = response.data ?? null
  if (data !== null) {
    foldUtilizationFromEndpoint(data, issuedEpoch)
  }
  return data
}
