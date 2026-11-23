import axios from 'axios'

import { anthropicAccountApiBase } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokens, hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'


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
    scope?: {
      model?: {
        display_name?: string | null
      } | null
    } | null
  }> | null
  extra_usage?: unknown
  spend?: unknown
}

const USAGE_TIMEOUT_MS = 5000

export function usageEndpointBase(): string {
  return anthropicAccountApiBase()
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  let mocked: Utilization | null = null
  try {
    const { mockUtilizationPayload } = require('../mockRateLimits.js') as typeof import('../mockRateLimits.js')
    mocked = mockUtilizationPayload()
  } catch (error) {
    logError(new Error(`fetchUtilization mockUtilizationPayload: ${errorMessage(error)}`))
  }
  if (mocked !== null) {
    try {
      const { foldUtilizationFromEndpoint } = require('../anthropicLimits.js') as typeof import('../anthropicLimits.js')
      foldUtilizationFromEndpoint(mocked, undefined)
    } catch (error) {
      logError(new Error(`fetchUtilization mock foldUtilizationFromEndpoint: ${errorMessage(error)}`))
    }
    return mocked
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  const auth = getAuthHeaders()
  if (auth.error !== undefined) {
    throw new Error(`Failed to build auth headers for usage fetch: ${auth.error}`)
  }

  let credentialEpoch: number | undefined
  try {
    const { getUsageCredentialEpoch } = require('../anthropicLimits.js') as typeof import('../anthropicLimits.js')
    credentialEpoch = getUsageCredentialEpoch()
  } catch (error) {
    logError(new Error(`fetchUtilization getUsageCredentialEpoch: ${errorMessage(error)}`))
    credentialEpoch = undefined
  }

  const response = await axios.get<Utilization>(`${usageEndpointBase()}/api/oauth/usage`, {
    timeout: USAGE_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getAnthropicClientUserAgent(),
      ...auth.headers,
    },
  })

  const data = response.data
  if (data != null) {
    try {
      const { foldUtilizationFromEndpoint } = require('../anthropicLimits.js') as typeof import('../anthropicLimits.js')
      foldUtilizationFromEndpoint(data, credentialEpoch)
    } catch (error) {
      logError(new Error(`fetchUtilization foldUtilizationFromEndpoint: ${errorMessage(error)}`))
    }
    return data
  }
  return null
}
