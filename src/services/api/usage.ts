import axios from 'axios'

import { getOauthConfig } from '../../constants/oauth.js'
import { getClaudeAIOAuthTokens, hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

/**
 * Fetches subscription rate-limit utilisation for the signed-in account.
 */

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
  // A non-subscription account, or one lacking the profile scope, has no
  // utilisation to report — an EMPTY OBJECT, not null, so callers can
  // distinguish "nothing to show" from "could not fetch".
  if (!isClaudeAISubscriber() || !hasProfileScope()) return {}

  // The fixture seam (the /mock-limits engine): an armed payload stands in
  // for the wire, so captures and journeys read the same panel the live
  // endpoint feeds — zero network, and the SAME fold seam below (the 5h/7d
  // windows land in the shared store exactly as a wire answer would).
  // Folded shut, the wire answers.
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
        /* the caller still gets the payload */
      }
      return mocked
    }
  } catch {
    /* the seam stays folded — the wire answers */
  }

  // An expired OAuth token would guarantee a 401; return null instead.
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt ?? null)) return null

  const auth = getAuthHeaders()
  if (auth.error !== undefined) {
    throw new Error(`Failed to build auth headers for usage fetch: ${auth.error}`)
  }

  // The observation belongs to the credential it was ISSUED under: capture
  // the epoch before the await, and refuse to fold a response that lands
  // after a sign-out/switch/gate-close bumped it (lane IV: the in-flight
  // answer repopulated the emptied feeders with the departed account's
  // windows — the zombie-usage race).
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
    // Every wire observation feeds the shared store (usage-truth lane): the
    // 5h/7d windows fold under the header record (claudeAiLimits — the
    // record the rail/deck/frame meters and the cap-failover read). One
    // endpoint, one fold seam, so no caller can freshen one surface and
    // strand another. Lazy require: claudeAiLimits sits under this module's
    // import graph, and the seam must never turn a fetched answer into a
    // throw — a store that refuses folds must not eat the data.
    try {
      const { foldUtilizationFromEndpoint } =
        require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
      foldUtilizationFromEndpoint(data, issuedEpoch)
    } catch {
      // The caller still gets the observation; the store catches up on its
      // own feeder (headers).
    }
  }
  return data
}
