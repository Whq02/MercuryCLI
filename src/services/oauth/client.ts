/**
 * First-party OAuth wire calls: authorize-URL construction, code exchange,
 * refresh (with the profile-skip double guard), roles, API-key creation,
 * profile normalisation, account-info persistence, error normalisation and
 * best-effort revocation.
 *
 * Every endpoint, client id and scope constant comes from the OAuth
 * constants module — never built here.
 */
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

/** The provider-call deadline law's wording on the axios legs: a breach of
 *  the exchange/refresh bound reads 'timed out after 15s — anthropic did
 *  not answer' (axios would otherwise hand the operator its own 'timeout of
 *  15000ms exceeded'); every other failure passes through untouched, so a
 *  refresh caller's dead-token classification never sees a timeout. */
export function honestDeadlineBreach(error: unknown, ms: number): unknown {
  if (error instanceof AxiosError && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
    return new Error(deadlineBreachLine('anthropic', ms))
  }
  return error
}
const EXPIRY_BUFFER_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** An account (claude.ai) login is one that granted the inference scope. */
export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  return scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE) ?? false
}

/** Split on spaces, drop empties; absent ⇒ empty. */
export function parseScopes(scopeString?: string | null): string[] {
  if (!scopeString) return []
  return scopeString.split(' ').filter(scope => scope !== '')
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

/**
 * Build the authorize URL. The account authorization base is used for
 * account logins, the console base otherwise; `code=true` tells the login
 * page to show the subscription upsell.
 */
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

// ---------------------------------------------------------------------------
// Code exchange
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** The stored credential, read directly from secure storage. */
function readStoredCredential(): OAuthTokens | undefined {
  return getSecureStorage().read()?.claudeAiOauth
}

/**
 * Skip the refresh profile round-trip only when BOTH the stored account
 * record (billing type + both created timestamps) AND the stored credential
 * (non-null subscription type + rate-limit tier) are fully populated.
 *
 * Both halves are load-bearing: on the supplied-refresh-token re-login path
 * the credential store is cleared AFTER this function returns, so a
 * config-only guard would let returned nulls be written back — permanently
 * satisfying the config half and silently losing the subscription type for
 * a paying customer. A genuinely empty credential store fails the guard and
 * takes the fetch.
 */
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

/** Update only the profile fields that are present; write only when at least
 *  one was collected (the store's own no-op comparison absorbs repeats). */
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

/**
 * Refresh the credential. The scope string is the caller's scopes when
 * non-empty, otherwise the full ACCOUNT scope set — the backend's refresh
 * grant may widen a token's scopes, which is how an older credential picks
 * up a scope that did not exist when it was issued.
 */
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
      // The token legs present the product identity like every other wire
      // (axios would otherwise spell its own library agent here).
      { timeout: EXCHANGE_TIMEOUT_MS, headers: { 'User-Agent': getMercuryUserAgent() } },
    )
  } catch (error) {
    if (error instanceof AxiosError && error.response !== undefined) {
      // The sanitized rewrap (no body, no config — the request data carries
      // the refresh token) MUST keep the dead-token classification: the
      // caller's invalid_grant check is what blanks the credential and
      // stops further refresh spends.
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

// ---------------------------------------------------------------------------
// Profile normalisation
// ---------------------------------------------------------------------------

const ORGANIZATION_SUBSCRIPTIONS: Record<string, SubscriptionType> = {
  claude_max: 'max',
  claude_pro: 'pro',
  claude_enterprise: 'enterprise',
  claude_team: 'team',
}

/** Fetch and normalise the profile for an access token; null on failure. */
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

// ---------------------------------------------------------------------------
// Roles + API keys
// ---------------------------------------------------------------------------

/** GET the roles endpoint and persist the roles onto the stored account. */
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

/** POST (empty body) to the key-creation endpoint; save + return the key. */
export async function createAndStoreApiKey(accessToken: string): Promise<string | null> {
  const config = getOauthConfig()
  // Bounded like its three siblings — this was the ONE axios call in the
  // file with no timeout, and the 'Minting the key…' screen deregisters
  // every key in that state: behind a captive portal or black-holed DNS the
  // spinner stood forever with esc dead and only the window's X left
  // (TASK-017 S2, login-mint-screen-has-no-key-at-all). Bounded, the wedge
  // becomes the flow's error state, where esc is live.
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

// ---------------------------------------------------------------------------
// Expiry + error normalisation
// ---------------------------------------------------------------------------

/** null expiry = never expires. Expired once now + 5 minutes reaches it. */
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false
  return Date.now() + EXPIRY_BUFFER_MS >= expiresAt
}

/** The accepted OAuth error-type shape. */
const OAUTH_ERROR_TYPE_RE = /^[a-z][a-z_]{0,39}$/

/** Extract the OAuth error `type` from either wire shape: a top-level string
 *  `error`, or a top-level `error` object with a string `type`. */
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

/**
 * The sanitized refresh-failure shape: HTTP status + parsed OAuth error type
 * survive the rewrap, the response body and request config (which carries
 * the refresh token) do not.
 */
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

/** A dead refresh token: status 400 or 401 AND type exactly `invalid_grant` —
 *  in either the raw axios shape or the sanitized refresh-failure rewrap. */
export function isInvalidGrantError(error: unknown): boolean {
  if (error instanceof OAuthRefreshHttpError) {
    return (error.status === 400 || error.status === 401) && error.oauthErrorType === 'invalid_grant'
  }
  if (!(error instanceof AxiosError) || error.response === undefined) return false
  const status = error.response.status
  if (status !== 400 && status !== 401) return false
  return oauthErrorType(error) === 'invalid_grant'
}

/**
 * Telemetry-safe error fields: the status (as a string) and the error type —
 * a type outside the accepted OAuth shape reports as `unparseable` rather
 * than passing through. Never includes the body. Nothing when there is no
 * HTTP response.
 */
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

// ---------------------------------------------------------------------------
// Revocation (best-effort, fails open)
// ---------------------------------------------------------------------------

/**
 * POST the token to `{TOKEN_URL}/revoke`. Any failure — including a non-2xx
 * — is logged at warning level (noting that local logout continues) and
 * swallowed, so logout always completes.
 */
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

// ---------------------------------------------------------------------------
// Organisation UUID + account persistence
// ---------------------------------------------------------------------------

/** The stored organisation uuid, else a profile fetch when the token has the
 *  profile scope, else nothing. */
export async function getOrganizationUUID(): Promise<string | undefined> {
  const stored = getGlobalConfig().oauthAccount?.organizationUuid
  if (stored) return stored
  const credential = readStoredCredential()
  if (!credential?.accessToken) return undefined
  if (!credential.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)) return undefined
  const profile = await getOauthProfileFromOauthToken(credential.accessToken)
  return profile?.organization?.uuid
}

/**
 * Populate the stored account when it is missing enrichment fields.
 *
 * The three environment variables are used (synchronously, network-free)
 * only when ALL THREE are set and no account is stored yet — removing the
 * race where early telemetry lacks account information. A later successful
 * profile fetch overrides them with an info-level log.
 */
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

  // Refresh already fetches and stores profile information; await any
  // in-flight refresh before deciding whether more work is needed.
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

/** Persist the account record; a field-by-field comparison skips no-op writes
 *  so a no-op refresh does not churn the config file. */
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
  // A DIFFERENT account arriving is a credential switch: the usage window
  // feeders belong to the departed account and must not survive it (lane IV — the reset owner existed with no live
  // caller; same-account field refreshes never reset). Lazy require: this
  // module sits under claudeAiLimits' import graph.
  if (existing !== undefined && existing.accountUuid !== info.accountUuid) {
    try {
      const { resetLimitsForCredentialSwitch } =
        require('../claudeAiLimits.js') as typeof import('../claudeAiLimits.js')
      resetLimitsForCredentialSwitch()
    } catch {
      // The config write must land regardless.
    }
  }
  saveGlobalConfig(current => ({ ...current, oauthAccount: info }))
  // The env-kept daemon residual: a sign-in
  // landing while THIS session's owned daemon still serves its spawn-time
  // env bearer asks it to restart when idle — the successor's gated scrub
  // re-resolves the stored account. Self-guarded and one-shot inside the
  // seam; fire-and-forget so the sign-in never waits on the daemon.
  void import('../../daemon/ownedDaemon.js')
    .then(m => m.restartOwnedDaemonForFreshSignin())
    .catch(() => {})
}
