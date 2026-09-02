import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'


export function getBridgeTokenOverride(): string | undefined {
  return undefined
}

export function getBridgeBaseUrlOverride(): string | undefined {
  return undefined
}

export function getBridgeAccessToken(): string | undefined {
  const override = getBridgeTokenOverride()
  if (override !== undefined) return override
  return getClaudeAIOAuthTokens()?.accessToken ?? undefined
}

export function getBridgeBaseUrl(): string {
  const override = getBridgeBaseUrlOverride()
  if (override !== undefined) return override
  return getOauthConfig().BASE_API_URL
}
