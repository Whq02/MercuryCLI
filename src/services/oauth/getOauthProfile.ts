import axios from 'axios'

import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import type { OAuthProfileResponse } from './types.js'

const PROFILE_TIMEOUT_MS = 10_000

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
