import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'

/**
 * Resolves the access token and base URL used by the surviving bridge HTTP
 * calls. The dev-override layer is compiled out: both override accessors
 * always yield nothing, and are kept because the composition below reads
 * them and they document the layering.
 */

export function getBridgeTokenOverride(): string | undefined {
  return undefined
}

export function getBridgeBaseUrlOverride(): string | undefined {
  return undefined
}

/**
 * The bearer token for bridge calls: the (inert) override, else the stored
 * subscriber OAuth access token. Nothing means "not logged in".
 */
export function getBridgeAccessToken(): string | undefined {
  const override = getBridgeTokenOverride()
  if (override !== undefined) return override
  return getClaudeAIOAuthTokens()?.accessToken ?? undefined
}

/**
 * The bridge base URL: the (inert) override, else the resolved OAuth API
 * base. Always returns a URL — or throws when the custom-OAuth override is
 * outside its allowlist.
 */
export function getBridgeBaseUrl(): string {
  const override = getBridgeBaseUrlOverride()
  if (override !== undefined) return override
  return getOauthConfig().BASE_API_URL
}
