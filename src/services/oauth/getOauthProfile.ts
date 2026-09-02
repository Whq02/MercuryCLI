import axios from 'axios'

import { OAUTH_BETA_HEADER, getOauthConfig } from '../../constants/oauth.js'
import { getAnthropicApiKey } from '../../utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import type { OAuthProfileResponse } from './types.js'

const PROFILE_TIMEOUT_MS = 10_000

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
