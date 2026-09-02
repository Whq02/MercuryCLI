import axios from 'axios'

import { getOauthConfig } from '../../constants/oauth.js'
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
}

const USAGE_TIMEOUT_MS = 5000

export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) return {}

  try {
    const { mockUtilizationPayload } =
      require('../mockRateLimits.js') as typeof import('../mockRateLimits.js')
    const mocked = mockUtilizationPayload()
    if (mocked !== null) {
      try {
        const { foldUtilizationFromEndpoint } =
          require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
        foldUtilizationFromEndpoint(mocked, undefined)
      } catch {
      }
      return mocked
    }
  } catch {
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt ?? null)) return null

  const auth = getAuthHeaders()
  if (auth.error !== undefined) {
    throw new Error(`Failed to build auth headers for usage fetch: ${auth.error}`)
  }

  let issuedEpoch: number | undefined
  try {
    const { getUsageCredentialEpoch } =
      require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
    issuedEpoch = getUsageCredentialEpoch()
  } catch {
    issuedEpoch = undefined
  }

  const base = getOauthConfig().BASE_API_URL
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
    try {
      const { foldUtilizationFromEndpoint } =
        require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
      foldUtilizationFromEndpoint(data, issuedEpoch)
    } catch {
    }
  }
  return data
}
