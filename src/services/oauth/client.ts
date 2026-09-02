import axios, { AxiosError } from 'axios'

import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  CLAUDE_AI_PROFILE_SCOPE,
  OAUTH_BETA_HEADER,
  getOauthConfig,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  isClaudeAISubscriber,
  saveApiKey,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig, type AccountInfo } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getMercuryUserAgent } from '../../utils/userAgent.js'
import { deadlineBreachLine } from '../providers/fetchDeadline.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
  UserRolesResponse,
} from './types.js'

const EXCHANGE_TIMEOUT_MS = 15_000
const REVOKE_TIMEOUT_MS = 5_000
const PROFILE_TIMEOUT_MS = 10_000

export function honestDeadlineBreach(error: unknown, ms: number): unknown {
  if (error instanceof AxiosError && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
    return new Error(deadlineBreachLine('anthropic', ms))
  }
  return error
}
const EXPIRY_BUFFER_MS = 5 * 60 * 1000


export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE) ?? false
}

export function parseScopes(scopeString?: string | null): string[] {
  if (!scopeString) return []
  return scopeString.split(' ').filter(scope => scope !== '')
}


export function buildAuthUrl({
  loginWithClaudeAi,
  isManual,
  port,
  codeChallenge,
  state,
  inferenceOnly,
  orgUUID,
  loginHint,
  loginMethod,
}: {
  loginWithClaudeAi: boolean
  isManual: boolean
  port: number
  codeChallenge: string
  state: string
  inferenceOnly?: boolean
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
}): string {
  const config = getOauthConfig()
  const base = loginWithClaudeAi ? config.CLAUDE_AI_AUTHORIZE_URL : config.CONSOLE_AUTHORIZE_URL
  const url = new URL(base)
  url.searchParams.append('code', 'true')
  url.searchParams.append('client_id', config.CLIENT_ID)
  url.searchParams.append('response_type', 'code')
  url.searchParams.append(
    'redirect_uri',
    isManual ? config.MANUAL_REDIRECT_URL : `http://localhost:${port}/callback`,
  )
  url.searchParams.append(
    'scope',
    inferenceOnly === true ? CLAUDE_AI_INFERENCE_SCOPE : ALL_OAUTH_SCOPES.join(' '),
  )
  url.searchParams.append('code_challenge', codeChallenge)
  url.searchParams.append('code_challenge_method', 'S256')
  url.searchParams.append('state', state)
  if (orgUUID !== undefined) url.searchParams.append('orgUUID', orgUUID)
  if (loginHint !== undefined) url.searchParams.append('login_hint', loginHint)
  if (loginMethod !== undefined) url.searchParams.append('login_method', loginMethod)
  return url.toString()
}


export async function exchangeCodeForTokens(
  code: string,
  state: string,
  verifier: string,
  port: number,
  useManualRedirect?: boolean,
  expiresIn?: number,
): Promise<OAuthTokenExchangeResponse> {
  const config = getOauthConfig()
  try {
    const response = await axios.post<OAuthTokenExchangeResponse>(
      config.TOKEN_URL,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri:
          useManualRedirect === true
            ? config.MANUAL_REDIRECT_URL
            : `http://localhost:${port}/callback`,
        client_id: config.CLIENT_ID,
        code_verifier: verifier,
        state,
        ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
      },
      { timeout: EXCHANGE_TIMEOUT_MS, headers: { 'User-Agent': getMercuryUserAgent() } },
    )
    return response.data
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 401) {
      throw new Error('Authentication failed: the authorization code is invalid or expired')
    }
    if (error instanceof AxiosError && error.response !== undefined) {
      throw new Error(
        `Token exchange failed with status ${error.response.status} (${error.response.statusText})`,
      )
    }
    throw honestDeadlineBreach(error, EXCHANGE_TIMEOUT_MS)
  }
}


function readStoredCredential(): OAuthTokens | undefined {
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
            : CLAUDE_AI_OAUTH_SCOPES.join(' '),
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

export async function fetchProfileInfo(accessToken: string): Promise<
  | (ReturnType<typeof normalizeProfile> & { profile: OAuthProfileResponse })
  | null
> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  if (profile === null) return null
  return normalizeProfile(profile)
}

function normalizeProfile(profile: OAuthProfileResponse): {
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


export async function fetchAndStoreUserRoles(accessToken: string): Promise<void> {
  const config = getOauthConfig()
  let response: { status: number; statusText: string; data: UserRolesResponse }
  try {
    response = await axios.get<UserRolesResponse>(config.ROLES_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': getMercuryUserAgent() },
    })
  } catch (error) {
    if (error instanceof AxiosError && error.response !== undefined) {
      throw new Error(`Failed to fetch user roles: ${error.response.statusText}`)
    }
    throw error
  }
  const account = getGlobalConfig().oauthAccount
  if (!account) {
    throw new Error('No OAuth account is stored; cannot persist user roles')
  }
  storeOAuthAccountInfo({
    ...account,
    organizationRole: response.data.organization_role,
    workspaceRole: response.data.workspace_role,
    organizationName: response.data.organization_name,
  })
}

export async function createAndStoreApiKey(accessToken: string): Promise<string | null> {
  const config = getOauthConfig()
  const response = await axios.post<{ raw_key?: string }>(
    config.API_KEY_URL,
    {},
    { timeout: EXCHANGE_TIMEOUT_MS, headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': getMercuryUserAgent() } },
  )
  const rawKey = response.data?.raw_key
  if (!rawKey) return null
  saveApiKey(rawKey)
  return rawKey
}


export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
}

const OAUTH_ERROR_TYPE_RE = /^[a-z][a-z_]{0,39}$/

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

export function extractOAuthErrorFields(
  error: unknown,
): { status: string; errorType?: string; isInvalidGrant?: boolean } | undefined {
  if (!(error instanceof AxiosError) || error.response === undefined) return undefined
  const rawType = oauthErrorType(error)
  const errorType =
    rawType === undefined ? undefined : OAUTH_ERROR_TYPE_RE.test(rawType) ? rawType : 'unparseable'
  return {
    status: String(error.response.status),
    ...(errorType === undefined ? {} : { errorType }),
    ...(errorType === 'invalid_grant' ? { isInvalidGrant: true } : {}),
  }
}


export async function revokeOAuthToken(token: string, clientId?: string): Promise<void> {
  const config = getOauthConfig()
  try {
    await axios.post(
      `${config.TOKEN_URL}/revoke`,
      {
        token,
        token_type_hint: 'refresh_token',
        client_id: clientId ?? config.CLIENT_ID,
      },
      { timeout: REVOKE_TIMEOUT_MS },
    )
  } catch (error) {
    const status =
      error instanceof AxiosError && error.response !== undefined
        ? `status ${error.response.status}`
        : 'a network failure'
    logError(
      `Warning: server-side OAuth token revocation failed (${status}); local logout continues`,
    )
  }
}


export async function getOrganizationUUID(): Promise<string | undefined> {
  const stored = getGlobalConfig().oauthAccount?.organizationUuid
  if (stored) return stored
  const credential = readStoredCredential()
  if (!credential?.accessToken) return undefined
  if (!credential.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)) return undefined
  const profile = await getOauthProfileFromOauthToken(credential.accessToken)
  return profile?.organization?.uuid
}

export async function populateOAuthAccountInfoIfNeeded(): Promise<void> {
  const envAccountUuid = process.env.MERCURY_ACCOUNT_UUID
  const envEmail = process.env.MERCURY_USER_EMAIL
  const envOrganizationUuid = process.env.MERCURY_ORGANIZATION_UUID
  let usedEnvironment = false
  if (envAccountUuid && envEmail && envOrganizationUuid && !getGlobalConfig().oauthAccount) {
    storeOAuthAccountInfo({
      accountUuid: envAccountUuid,
      emailAddress: envEmail,
      organizationUuid: envOrganizationUuid,
    })
    usedEnvironment = true
  }

  await checkAndRefreshOAuthTokenIfNeeded()

  const account = getGlobalConfig().oauthAccount
  if (account?.billingType && account.accountCreatedAt && account.subscriptionCreatedAt) return
  if (!isClaudeAISubscriber()) return
  const credential = readStoredCredential()
  if (!credential?.accessToken) return
  if (!credential.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)) return

  const profile = await getOauthProfileFromOauthToken(credential.accessToken)
  if (profile === null) return
  const normalized = normalizeProfile(profile)
  storeOAuthAccountInfo({
    accountUuid: profile.account.uuid,
    emailAddress: profile.account.email,
    ...(profile.organization.uuid ? { organizationUuid: profile.organization.uuid } : {}),
    ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
    billingType: normalized.billingType,
    ...(normalized.accountCreatedAt ? { accountCreatedAt: normalized.accountCreatedAt } : {}),
    ...(normalized.subscriptionCreatedAt
      ? { subscriptionCreatedAt: normalized.subscriptionCreatedAt }
      : {}),
  })
  if (usedEnvironment) {
    logForDebugging(
      'OAuth account info: the fetched profile overrode the environment-supplied account fields',
    )
  }
}

export function storeOAuthAccountInfo(info: AccountInfo): void {
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
        require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
      resetLimitsForCredentialSwitch()
    } catch {
    }
  }
  saveGlobalConfig(current => ({ ...current, oauthAccount: info }))
  void import('../../daemon/ownedDaemon.js')
    .then(m => m.restartOwnedDaemonForFreshSignin())
    .catch(() => {})
}
