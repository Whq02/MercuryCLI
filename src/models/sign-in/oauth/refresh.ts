import axios, { AxiosError } from 'axios'

import {
  SUBSCRIPTION_OAUTH_SCOPES,
  getOauthConfig,
} from './oauth.js'
import { isOAuthTokenExpired, parseScopes, shouldUseClaudeAIAuth } from '../oauth-shapes/scopes.js'
export { isOAuthTokenExpired, parseScopes, shouldUseClaudeAIAuth }
import { getGlobalConfig, saveGlobalConfig, type AccountInfo } from '../../../platform/settings/config.js'
import { getSecureStorage } from '../../../platform/secure-storage/index.js'
import { getMercuryUserAgent } from '../../../platform/network/userAgent.js'
import { deadlineBreachLine } from '../../roads/fetchDeadline.js'
import { getOauthProfileFromOauthToken } from '../oauth-shapes/getOauthProfile.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from '../oauth-shapes/types.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

export const EXCHANGE_TIMEOUT_MS = 15_000

export function honestDeadlineBreach(error: unknown, ms: number): unknown {
  if (error instanceof AxiosError && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
    return new Error(deadlineBreachLine('anthropic', ms))
  }
  return error
}

export function readStoredCredential(): OAuthTokens | undefined {
  return getSecureStorage().read()?.claudeAiOauth
}

function canSkipProfileFetch(): boolean {
  const account = getGlobalConfig().oauthAccount
  if (!account?.billingType || !account.accountCreatedAt || !account.subscriptionCreatedAt) {
    return false
  }
  const credential = readStoredCredential()
  return (
    credential !== undefined &&
    credential.subscriptionType !== null &&
    credential.rateLimitTier !== null
  )
}

function applyProfileToAccount(profile: OAuthProfileResponse): void {
  const organization = profile.organization
  const account = profile.account
  const updates: Partial<AccountInfo> = {}
  let collected = 0
  if (account.display_name) {
    updates.displayName = account.display_name
    collected++
  }
  if (organization.billing_type !== null && organization.billing_type !== undefined) {
    updates.billingType = organization.billing_type
    collected++
  }
  if (account.created_at) {
    updates.accountCreatedAt = account.created_at
    collected++
  }
  if (organization.subscription_created_at) {
    updates.subscriptionCreatedAt = organization.subscription_created_at
    collected++
  }
  if (collected === 0) return
  const existing = getGlobalConfig().oauthAccount
  if (!existing) return
  storeOAuthAccountInfo({ ...existing, ...updates })
}

export async function refreshOAuthToken(
  refreshToken: string,
  { scopes }: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const config = getOauthConfig()
  let response: { data: OAuthTokenExchangeResponse }
  try {
    response = await axios.post<OAuthTokenExchangeResponse>(
      config.TOKEN_URL,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.CLIENT_ID,
        scope:
          scopes !== undefined && scopes.length > 0
            ? scopes.join(' ')
            : SUBSCRIPTION_OAUTH_SCOPES.join(' '),
      },
      { timeout: EXCHANGE_TIMEOUT_MS, headers: { 'User-Agent': getMercuryUserAgent() } },
    )
  } catch (error) {
    if (error instanceof AxiosError && error.response !== undefined) {
      throw new OAuthRefreshHttpError(
        `Token refresh failed: ${error.response.statusText}`,
        error.response.status,
        oauthErrorType(error),
      )
    }
    throw honestDeadlineBreach(error, EXCHANGE_TIMEOUT_MS)
  }
  const data = response.data
  const grantedScopes = parseScopes(data.scope)

  let fetched: ReturnType<typeof normalizeProfile> | null = null
  if (!canSkipProfileFetch()) {
    const profile = await getOauthProfileFromOauthToken(data.access_token)
    if (profile !== null) {
      fetched = normalizeProfile(profile)
      applyProfileToAccount(profile)
    }
  }

  const existing = readStoredCredential()
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? existing?.refreshToken ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: grantedScopes,
    subscriptionType: fetched?.subscriptionType ?? existing?.subscriptionType ?? null,
    rateLimitTier: fetched?.rateLimitTier ?? existing?.rateLimitTier ?? null,
    ...(fetched?.profile !== undefined ? { profile: fetched.profile } : {}),
    ...(existing?.tokenAccount !== undefined ? { tokenAccount: existing.tokenAccount } : {}),
  }
}

const ORGANIZATION_SUBSCRIPTIONS: Record<string, SubscriptionType> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_enterprise: 'enterprise',
  claude_team: 'team',
}

export function normalizeProfile(profile: OAuthProfileResponse): {
  subscriptionType: SubscriptionType | null
  rateLimitTier: RateLimitTier | null
  billingType: BillingType | null
  displayName?: string
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  profile: OAuthProfileResponse
} {
  const organization = profile.organization
  const organizationType = organization.organization_type
  return {
    subscriptionType:
      organizationType !== undefined && organizationType !== null
        ? (ORGANIZATION_SUBSCRIPTIONS[organizationType] ?? null)
        : null,
    rateLimitTier: organization.rate_limit_tier ?? null,
    billingType: organization.billing_type ?? null,
    ...(profile.account.display_name ? { displayName: profile.account.display_name } : {}),
    ...(profile.account.created_at ? { accountCreatedAt: profile.account.created_at } : {}),
    ...(organization.subscription_created_at
      ? { subscriptionCreatedAt: organization.subscription_created_at }
      : {}),
    profile,
  }
}

function oauthErrorType(error: unknown): string | undefined {
  if (!(error instanceof AxiosError) || error.response === undefined) return undefined
  const body = error.response.data as { error?: unknown } | undefined
  const errorField = body?.error
  if (typeof errorField === 'string') return errorField
  if (
    errorField !== null &&
    typeof errorField === 'object' &&
    typeof (errorField as { type?: unknown }).type === 'string'
  ) {
    return (errorField as { type: string }).type
  }
  return undefined
}

export class OAuthRefreshHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly oauthErrorType: string | undefined,
  ) {
    super(message)
    this.name = 'OAuthRefreshHttpError'
  }
}

export function isInvalidGrantError(error: unknown): boolean {
  if (error instanceof OAuthRefreshHttpError) {
    return (error.status === 400 || error.status === 401) && error.oauthErrorType === 'invalid_grant'
  }
  if (!(error instanceof AxiosError) || error.response === undefined) return false
  const status = error.response.status
  if (status !== 400 && status !== 401) return false
  return oauthErrorType(error) === 'invalid_grant'
}

let pendingDaemonRestart: Promise<string | null> | null = null

export async function awaitStoredOAuthDaemonRestart(): Promise<string | null> {
  const pending = pendingDaemonRestart
  pendingDaemonRestart = null
  if (pending === null) return null
  return pending
}

export function daemonRestartFailedNotice(error: string): string {
  return `signed in, but the background daemon could not be restarted (${error}) — run \`mercury daemon restart\` so it uses this sign-in`
}

export function storeOAuthAccountInfo(info: AccountInfo): void {
  pendingDaemonRestart = null
  const existing = getGlobalConfig().oauthAccount
  if (existing !== undefined) {
    const keys = new Set([...Object.keys(existing), ...Object.keys(info)])
    let changed = false
    for (const key of keys) {
      if (
        (existing as Record<string, unknown>)[key] !== (info as Record<string, unknown>)[key]
      ) {
        changed = true
        break
      }
    }
    if (!changed) return
  }
  if (existing !== undefined && existing.accountUuid !== info.accountUuid) {
    try {
      const { resetLimitsForCredentialSwitch } =
        require('../../roads/anthropic/anthropicLimits.js') as typeof import('../../roads/anthropic/anthropicLimits.js')
      resetLimitsForCredentialSwitch()
    } catch (error) {
      logError(`storeOAuthAccountInfo: resetLimitsForCredentialSwitch failed: ${error instanceof Error ? error.message : String(error)}`)
      passedOver(error)
    }
  }
  saveGlobalConfig(current => ({ ...current, oauthAccount: info }))
  const restart = import('../../../daemon/control/ownedDaemon.js')
    .then(m => m.restartOwnedDaemonForFreshSignin())
    .then(
      () => null,
      (error: unknown) => {
        passedOver(error)
        return error instanceof Error ? error.message : String(error)
      },
    )
  pendingDaemonRestart = restart
  void restart
}
