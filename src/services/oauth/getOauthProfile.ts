/**
 * The two OAuth profile-fetch calls. Both swallow failures — a profile is an
 * enrichment, never a blocker — and resolve to null on any error.
 */
import axios from 'axios'

import { OAUTH_BETA_HEADER, getOauthConfig } from '../../constants/oauth.js'
import { getAnthropicApiKey } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import type { OAuthProfileResponse } from './types.js'

const PROFILE_TIMEOUT_MS = 10_000

/**
 * API-key-authenticated profile fetch. Returns null WITHOUT issuing a
 * request unless both a stored account uuid and a retrievable API key exist.
 */
export async function getOauthProfileFromApiKey(): Promise<OAuthProfileResponse | null> {
  const accountUuid = getGlobalConfig().oauthAccount?.accountUuid
  if (!accountUuid) return null
  const apiKey = getAnthropicApiKey()
  if (!apiKey) return null
  try {
    const response = await axios.get<OAuthProfileResponse>(
      `${getOauthConfig().BASE_API_URL}/api/claude_cli_profile`,
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        params: { account_uuid: accountUuid },
        timeout: PROFILE_TIMEOUT_MS,
      },
    )
    return response.data
  } catch (error) {
    logForDebugging(`API-key profile fetch failed: ${String(error)}`)
    return null
  }
}

/** Bearer-authenticated profile fetch. */
export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | null> {
  try {
    const response = await axios.get<OAuthProfileResponse>(
      `${getOauthConfig().BASE_API_URL}/api/oauth/profile`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: PROFILE_TIMEOUT_MS,
      },
    )
    return response.data
  } catch (error) {
    logForDebugging(`OAuth profile fetch failed: ${String(error)}`)
    return null
  }
}
