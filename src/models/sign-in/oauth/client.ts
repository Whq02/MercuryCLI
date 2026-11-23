import axios, { AxiosError } from 'axios'

import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import {
  ALL_OAUTH_SCOPES,
  INFERENCE_SCOPE,
  PROFILE_SCOPE,
  getOauthConfig,
} from './oauth.js'
import { isClaudeAISubscriber, saveApiKey } from '../credentials/auth.js'
import { checkAndRefreshOAuthTokenIfNeeded } from '../lifecycle/oauthLifecycle.js'
import { getGlobalConfig, saveGlobalConfig, type AccountInfo } from '../../../platform/settings/config.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getAuthScope } from '../../../platform/environment/envUtils.js'
import { apiTimeoutMsOverride } from '../../../platform/environment/envValidation.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { getMercuryUserAgent } from '../../../platform/network/userAgent.js'
import { getOauthProfileFromOauthToken } from '../oauth-shapes/getOauthProfile.js'
import type {
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  UserRolesResponse,
} from '../oauth-shapes/types.js'
import { EXCHANGE_TIMEOUT_MS, honestDeadlineBreach, normalizeProfile, readStoredCredential, refreshOAuthToken, storeOAuthAccountInfo } from './refresh.js'

export { honestDeadlineBreach, isInvalidGrantError, isOAuthTokenExpired, OAuthRefreshHttpError, parseScopes, refreshOAuthToken, shouldUseClaudeAIAuth, storeOAuthAccountInfo } from './refresh.js'

const REVOKE_TIMEOUT_MS = 5_000
const PROFILE_TIMEOUT_MS = 10_000


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
  const base = loginWithClaudeAi ? config.SUBSCRIPTION_AUTHORIZE_URL : config.CONSOLE_AUTHORIZE_URL
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
    inferenceOnly === true ? INFERENCE_SCOPE : ALL_OAUTH_SCOPES.join(' '),
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


export async function refreshSignInGrant(
  refreshToken: string,
  options: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  const tokens: OAuthTokens = { ...(await refreshOAuthToken(refreshToken, options)) }
  delete tokens.tokenAccount
  return tokens
}


export async function fetchProfileInfo(accessToken: string): Promise<
  | (ReturnType<typeof normalizeProfile> & { profile: OAuthProfileResponse })
  | null
> {
  const profile = await getOauthProfileFromOauthToken(accessToken)
  if (profile === null) return null
  return normalizeProfile(profile)
}


export async function fetchAndStoreUserRoles(
  accessToken: string,
  origin?: { account: AccountInfo; authScope: string | undefined; isCurrent: () => boolean; signal?: AbortSignal },
): Promise<void> {
  const account = origin?.account ?? getGlobalConfig().oauthAccount
  if (!account) {
    throw new Error('No OAuth account is stored; cannot persist user roles')
  }
  const { accountUuid, organizationUuid } = account
  const authScope = origin === undefined ? getAuthScope() : origin.authScope
  const isCurrent = (stored: AccountInfo | undefined): boolean =>
    stored !== undefined && stored.accountUuid === accountUuid && stored.organizationUuid === organizationUuid &&
    getAuthScope() === authScope && (origin?.isCurrent() ?? true) && !origin?.signal?.aborted
  const ignored = (): void => logForDebugging('OAuth roles response ignored: the account, authentication scope or login changed')
  if (!isCurrent(getGlobalConfig().oauthAccount)) {
    ignored()
    return
  }
  const config = getOauthConfig()
  const timeout = apiTimeoutMsOverride() ?? PROFILE_TIMEOUT_MS
  let response: { status: number; statusText: string; data: UserRolesResponse }
  try {
    response = await axios.get<UserRolesResponse>(config.ROLES_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': getMercuryUserAgent() },
      timeout,
      ...(origin?.signal ? { signal: origin.signal } : {}),
    })
  } catch (error) {
    if (origin?.signal?.aborted) {
      ignored()
      return
    }
    if (error instanceof AxiosError && error.response !== undefined) {
      throw new Error(`Failed to fetch user roles: ${error.response.statusText}`)
    }
    throw honestDeadlineBreach(error, timeout)
  }
  saveGlobalConfig(current => {
    if (!isCurrent(current.oauthAccount)) {
      ignored()
      return current
    }
    return {
      ...current,
      oauthAccount: {
        ...current.oauthAccount!,
        organizationRole: response.data.organization_role,
        workspaceRole: response.data.workspace_role,
        organizationName: response.data.organization_name,
      },
    }
  })
}

export async function createAndStoreApiKey(accessToken: string): Promise<string | null> {
  const config = getOauthConfig()
  let response: { data?: { raw_key?: string; workspace_id?: string } }
  try {
    response = await axios.post<{ raw_key?: string; workspace_id?: string }>(
      config.API_KEY_URL,
      {},
      { timeout: EXCHANGE_TIMEOUT_MS, headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': getMercuryUserAgent() } },
    )
  } catch (error) {
    const said = serverErrorSentence(error)
    if (said !== undefined) throw new Error(said)
    throw honestDeadlineBreach(error, EXCHANGE_TIMEOUT_MS)
  }
  const rawKey = response.data?.raw_key
  if (!rawKey) return null
  await saveApiKey(rawKey, { workspaceId: response.data?.workspace_id })
  return rawKey
}

function serverErrorSentence(error: unknown): string | undefined {
  if (!(error instanceof AxiosError) || error.response === undefined) return undefined
  const body = error.response.data as { error?: unknown; message?: unknown; error_description?: unknown } | undefined
  if (body === undefined || body === null || typeof body !== 'object') return undefined
  const nested = body.error
  const candidates = [
    nested !== null && typeof nested === 'object' ? (nested as { message?: unknown }).message : undefined,
    body.message,
    body.error_description,
  ]
  const said = candidates.find(value => typeof value === 'string' && value.trim() !== '') as string | undefined
  return said?.trim()
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


export async function populateOAuthAccountInfoIfNeeded(): Promise<void> {
  const envAccountUuid = flagEnv('MERCURY_ACCOUNT_UUID')
  const envEmail = flagEnv('MERCURY_USER_EMAIL')
  const envOrganizationUuid = flagEnv('MERCURY_ORGANIZATION_UUID')
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
  if (!credential.scopes.includes(PROFILE_SCOPE)) return

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

export function accountInfoFromTokens(tokens: OAuthTokens): AccountInfo | undefined {
  const profile = tokens.profile
  if (profile !== undefined && profile.account?.uuid && profile.account.email) {
    const organization = profile.organization
    return {
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      ...(organization?.uuid ? { organizationUuid: organization.uuid } : {}),
      ...(profile.account.display_name ? { displayName: profile.account.display_name } : {}),
      ...(organization?.billing_type != null ? { billingType: organization.billing_type } : {}),
      ...(profile.account.created_at ? { accountCreatedAt: profile.account.created_at } : {}),
      ...(organization?.subscription_created_at ? { subscriptionCreatedAt: organization.subscription_created_at } : {}),
    }
  }
  const account = tokens.tokenAccount
  if (account !== undefined && account.uuid && account.emailAddress) {
    return {
      accountUuid: account.uuid,
      emailAddress: account.emailAddress,
      ...(account.organizationUuid ? { organizationUuid: account.organizationUuid } : {}),
    }
  }
  return undefined
}

