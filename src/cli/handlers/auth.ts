// ============================================================================
//  src/cli/handlers/auth.ts — `mercury auth login/status/logout` and the
//  shared OAuth-token installation used by the SDK claude_authenticate flow
//  and the interactive console OAuth component.
// ============================================================================
import { writeSync } from 'node:fs'
import { cliOk } from '../exit.js'
import {
  clearApiKeyHelperCache,
  clearOAuthTokenCache,
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getSubscriptionType,
  loginShadowWarning,
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
} from '../../utils/auth.js'
import {
  binaryName,
  getGlobalConfig,
  saveGlobalConfig,
  type AccountInfo,
} from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { recordSignIn } from '../../utils/accounts/signInLedger.js'
import { OAuthService } from '../../services/oauth/index.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  fetchProfileInfo,
  refreshOAuthToken,
  parseScopes,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
  propertyValueToText,
} from '../../utils/status.js'
import { maybeMarkProjectOnboardingComplete } from '../../projectOnboardingState.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// Clears stale credential state while PRESERVING onboarding completion. A
// dedicated shared owner was searched for and not found (rg for exported
// logout/performLogout/clearCredentials under src/utils and a
// preserveOnboarding spelling across src/); composed from the landed
// primitives instead — the token write below overwrites stored credentials,
// so this clears the account record and the memoized caches only.
function logoutPreservingOnboarding(): void {
  saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
  clearOAuthTokenCache()
  clearApiKeyHelperCache()
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  // The cleared account's usage truth clears with it (lane IV).
  try {
    const { resetLimitsForCredentialSwitch } =
      require('../../services/claudeAiLimits.js') as typeof import('../../services/claudeAiLimits.js')
    resetLimitsForCredentialSwitch()
  } catch {
    // Best-effort: the credential clear above is the load-bearing step.
  }
}

/**
 * The shared installation of OAuth tokens. Throws when API-key
 * creation is required for a console-scope token and fails.
 */
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // 1 — log out first, preserving onboarding completion.
  logoutPreservingOnboarding()

  // 2 — resolve the account profile: the profile carried on the tokens wins;
  // otherwise fetch it with the access token.
  const rawProfile = tokens.profile
  const fetched =
    rawProfile === undefined ? await fetchProfileInfo(tokens.accessToken) : null
  const profile = rawProfile ?? fetched?.profile
  if (profile) {
    const account: AccountInfo = {
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      // An empty display name is stored as absent.
      ...(profile.account.display_name
        ? { displayName: profile.account.display_name }
        : {}),
      ...(profile.organization.billing_type != null
        ? { billingType: profile.organization.billing_type }
        : {}),
      ...(profile.organization.subscription_created_at
        ? { subscriptionCreatedAt: profile.organization.subscription_created_at }
        : {}),
      ...(profile.account.created_at
        ? { accountCreatedAt: profile.account.created_at }
        : {}),
    }
    storeOAuthAccountInfo(account)
  } else if (tokens.tokenAccount) {
    // No profile at all: fall back to the token-exchange account data.
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      ...(tokens.tokenAccount.organizationUuid
        ? { organizationUuid: tokens.tokenAccount.organizationUuid }
        : {}),
    })
  }

  // 3 — save the tokens (idempotent) and drop the memoized token cache.
  // The save truth (prove-login-save-truth §4): a save both storage legs
  // refused must throw — the headless door must never report a sign-in
  // over a credential that did not land.
  const saved = saveOAuthTokensIfNeeded(tokens)
  if (!saved.success) {
    throw new Error(saved.warning ?? 'the credential could not be saved to secure storage')
  }
  clearOAuthTokenCache()

  // 4 — roles are not core auth, and a narrow-scope token is not entitled to
  // read them; a failure is expected, not exceptional.
  try {
    await fetchAndStoreUserRoles(tokens.accessToken)
  } catch (error) {
    logError(error)
  }

  // 5 — console/API scopes NEED a stored API key; this must throw on
  // failure, including a server that accepts the request but returns none.
  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        'The server accepted the API key request but returned no key',
      )
    }
  }

  // 5b — the sign-in ledger (the computed default orders by the most recent
  // sign-in): the credential landed on the arm the scopes name.
  recordSignIn('anthropic', shouldUseClaudeAIAuth(tokens.scopes) ? 'oauth' : 'api-key')

  // 6 — clear auth-related caches.
  clearOAuthTokenCache()
  clearApiKeyHelperCache()
}

function sslHintFor(error: unknown): string | undefined {
  const text = error instanceof Error ? `${error.message} ${String((error as { code?: string }).code ?? '')}` : String(error)
  if (/(CERT_|SSL|TLS|UNABLE_TO_VERIFY|self[- ]signed)/i.test(text)) {
    return 'This looks TLS-related — if you are behind a proxy, set NODE_EXTRA_CA_CERTS to your proxy certificate bundle.'
  }
  return undefined
}

export async function authLogin(opts: {
  email?: string
  sso?: boolean
  console?: boolean
  claudeai?: boolean
}): Promise<void> {
  if (opts.console && opts.claudeai) {
    console.error('--console and --claudeai cannot be combined')
    process.exit(1)
  }
  // The login method is a hard constraint when an enterprise setting forces
  // it; only when unforced do the flags decide. --claudeai has no effect of
  // its own — "not console" already means subscription.
  const forcedMethod = getInitialSettings().forceLoginMethod
  const loginWithClaudeAi = forcedMethod
    ? forcedMethod === 'claudeai'
    : !opts.console
  const forcedOrgUUID = getInitialSettings().forceLoginOrgUUID

  // Environment fast path: a supplied refresh token skips the browser flow.
  const envRefreshToken = process.env.MERCURY_OAUTH_REFRESH_TOKEN
  if (envRefreshToken) {
    const scopesRaw = process.env.MERCURY_OAUTH_SCOPES
    if (!scopesRaw) {
      console.error(
        'MERCURY_OAUTH_SCOPES must be set to the space-separated scope list the refresh token was issued with (for example "org:create_api_key user:profile user:inference").',
      )
      process.exit(1)
    }
    try {
      const tokens = await refreshOAuthToken(envRefreshToken, {
        scopes: parseScopes(scopesRaw),
      })
      await installOAuthTokens(tokens)
      const validation = await validateForceLoginOrg()
      if (!validation.valid) {
        console.error(validation.message)
        process.exit(1)
      }
      maybeMarkProjectOnboardingComplete()
      // writeSync: a win32 TTY stream write is async and the exit can
      // discard it — the sign-in result must never vanish (failLoud).
      try {
        writeSync(1, 'Signed in with the environment refresh token\n')
        const shadow = loginShadowWarning()
        if (shadow) writeSync(1, `${shadow}\n`)
      } catch {
        /* a closed fd must not mask the exit */
      }
      process.exit(0)
    } catch (error) {
      logError(error)
      const hint = sslHintFor(error)
      console.error(
        `Sign-in failed: ${error instanceof Error ? error.message : String(error)}${hint ? `\n${hint}` : ''}`,
      )
      process.exit(1)
    }
    return
  }

  // Browser path.
  const service = new OAuthService()
  try {
    const tokens = await service.startOAuthFlow(
      async (autoUrl, manualUrl) => {
        process.stdout.write('Opening the sign-in page in your browser…\n')
        process.stdout.write(`If it did not open, visit: ${manualUrl ?? autoUrl}\n`)
      },
      {
        loginWithClaudeAi,
        ...(opts.sso ? { loginMethod: 'sso' as const } : {}),
        ...(opts.email ? { loginHint: opts.email } : {}),
        ...(forcedOrgUUID ? { orgUUID: forcedOrgUUID } : {}),
      },
    )
    await installOAuthTokens(tokens)
    const validation = await validateForceLoginOrg()
    if (!validation.valid) {
      console.error(validation.message)
      process.exit(1)
    }
    try {
      writeSync(1, 'Signed in\n')
      const shadow = loginShadowWarning()
      if (shadow) writeSync(1, `${shadow}\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
    process.exit(0)
  } catch (error) {
    logError(error)
    const hint = sslHintFor(error)
    console.error(
      `Sign-in failed: ${error instanceof Error ? error.message : String(error)}${hint ? `\n${hint}` : ''}`,
    )
    process.exit(1)
  } finally {
    service.cleanup()
  }
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const tokenSource = getAuthTokenSource()
  // Presence read, custodian law (the providerUsage precedent):
  // the no-credential CI/test environments THROW in the key ladder (the
  // utils/auth arm-3 refusal) — a refusing custodian never crashes an
  // introspection surface, and reporting absence is this verb's whole job.
  // Read the refusal as `none`; the run paths keep their loud wall.
  const apiKey = ((): ReturnType<typeof getAnthropicApiKeyWithSource> => {
    try {
      return getAnthropicApiKeyWithSource()
    } catch {
      return { key: null, source: 'none' }
    }
  })()
  const envApiKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY)
  const account = getGlobalConfig().oauthAccount
  const subscriptionType = getSubscriptionType()

  const loggedIn =
    tokenSource.hasToken ||
    apiKey.source !== 'none' ||
    envApiKeyPresent
  const routed = routedProviderRows(loggedIn)

  // Precedence order is contract data — scripts consume the strings.
  const authMethod =
    tokenSource.hasToken && tokenSource.source === 'claude.ai'
      ? 'claude.ai'
      : tokenSource.hasToken && tokenSource.source === 'apiKeyHelper'
        ? 'api_key_helper'
        : tokenSource.hasToken && tokenSource.source !== 'none'
          ? 'oauth_token'
          : apiKey.source === 'ANTHROPIC_API_KEY' || envApiKeyPresent
            ? 'api_key'
            : apiKey.source === '/logins managed key'
              ? 'claude.ai'
              : 'none'

  if (opts.text) {
    const properties = [...buildAccountProperties(), ...buildAPIProviderProperties()]
    let printed = 0
    for (const property of properties) {
      const value = property.value
      if (value === null || value === undefined || value === 'none') continue
      // The values are screen elements; their text is the row (String() on
      // an element printed "[object Object]" for every row).
      const rendered = propertyValueToText(value)
      if (!rendered || rendered === 'none') continue
      printed++
      // writeSync throughout the status surface: these rows share the tick
      // with the exit below, and a win32 TTY stream write queued in that
      // tick can be discarded by it.
      try {
        writeSync(1, property.label ? `${property.label}: ${rendered}\n` : `${rendered}\n`)
      } catch {
        /* a closed fd must not mask the status exit */
      }
    }
    if (printed === 0 && envApiKeyPresent) {
      try {
        writeSync(1, 'API key from ANTHROPIC_API_KEY\n')
      } catch {
        /* a closed fd must not mask the status exit */
      }
    }
    // The other families, from the ONE presence owner — the same identity
    // words the screens print (the sign-in's email over the plan label).
    // Before this, the text verb reported the Anthropic ladder alone and
    // told a ChatGPT-only operator "Not signed in" while every screen said
    // signed in.
    const others = routed.rows.filter(row => row.id !== 'anthropic' && row.present)
    for (const row of others) {
      try {
        writeSync(1, `${row.id}: ${row.identity ?? row.source}\n`)
      } catch {
        /* a closed fd must not mask the status exit */
      }
    }
    if (!loggedIn) {
      try {
        writeSync(
          1,
          others.length > 0
            ? `No Anthropic credential — ${others.map(row => row.id).join(', ')} signed in; run: ${binaryName()} auth login to add Anthropic\n`
            : `Not signed in — run: ${binaryName()} auth login\n`,
        )
      } catch {
        /* a closed fd must not mask the status exit */
      }
    }
  } else {
    const payload: Record<string, unknown> = {
      loggedIn,
      authMethod,
      // Contract field: scripts consume this string. Always first-party —
      // there is no gateway estate.
      apiProvider: 'firstParty',
    }
    const apiKeySource =
      apiKey.source !== 'none'
        ? apiKey.source
        : envApiKeyPresent
          ? 'ANTHROPIC_API_KEY'
          : undefined
    if (apiKeySource !== undefined) payload.apiKeySource = apiKeySource
    if (authMethod === 'claude.ai') {
      payload.email = account?.emailAddress ?? null
      payload.orgId = account?.organizationUuid ?? null
      payload.orgName = account?.organizationName ?? null
      payload.subscriptionType = subscriptionType ?? null
    }
    // The per-family rows + the routed verdict (FN-013 AUTH-05): the one
    // machine-readable auth contract used to see the Anthropic ladder
    // alone — blind to nine of ten families, so a CI job pinned to an
    // engine model false-greened with the engine credential missing. Each
    // declared family reports id, credential kind, source label and
    // presence (never a secret); the exit code answers for the family the
    // session will route to. The Anthropic-only fields above stay frozen
    // (loggedIn / authMethod / apiProvider — scripts consume them). No
    // probe, no network call: the snapshot reads recorded local state.
    payload.routedProvider = routed.family
    payload.providers = routed.rows
    // writeSync: the --json payload is contract output scripts consume,
    // and a win32 TTY stream write can be discarded by the exit below.
    try {
      writeSync(1, `${jsonStringify(payload, undefined, 2)}\n`)
    } catch {
      /* a closed fd must not mask the exit */
    }
  }
  // The exit code is the answer — for the ROUTED family (FN-013 AUTH-05):
  // Anthropic-routed sessions answer the ladder exactly as before; a
  // session routed to another family answers that family's presence.
  process.exit(routed.family === 'anthropic' ? (loggedIn ? 0 : 1) : routed.present ? 0 : 1)
}

/** The declared-family rows + the routed family's presence, composed from
 *  the router snapshot (adapter status is recorded local state — cheap,
 *  sync, never a network call; "validity untested by design" holds), with
 *  each family's recorded identity from the ONE presence owner (the same
 *  words the screens print; additive — the frozen fields stand). */
function routedProviderRows(anthropicPresent: boolean): {
  family: string
  present: boolean
  rows: Array<{ id: string; kind: string; source: string; present: boolean; identity?: string }>
} {
  try {
    const { declaredRouteOf } = require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
    const { getMainLoopModel } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
    const { buildRouterModelSnapshot } = require('../../utils/router/modelRegistry.js') as typeof import('../../utils/router/modelRegistry.js')
    const { providerFamilyPresences } =
      require('../../services/providers/providerUsage.js') as typeof import('../../services/providers/providerUsage.js')
    const family = declaredRouteOf(getMainLoopModel()) ?? 'anthropic'
    const snapshot = buildRouterModelSnapshot()
    const presences = ((): ReturnType<typeof providerFamilyPresences> => {
      try {
        return providerFamilyPresences(snapshot.providers)
      } catch {
        return [] // identity is additive — the rows stand without it
      }
    })()
    const rows = snapshot.providers.map(provider => {
      const account = provider.description.account
      const present = provider.id === 'anthropic' ? anthropicPresent : account.kind !== 'none'
      const identity = presences.find(presence => presence.id === provider.id)?.identity
      return {
        id: provider.id,
        kind: account.kind,
        source: account.label,
        present,
        ...(identity !== undefined ? { identity } : {}),
      }
    })
    const routedRow = rows.find(row => row.id === family)
    return { family, present: routedRow?.present ?? false, rows }
  } catch {
    // The rows are additive contract surface — a failure to compose them
    // degrades to the Anthropic-only answer, never a crash.
    return { family: 'anthropic', present: anthropicPresent, rows: [] }
  }
}

export async function authLogout(): Promise<void> {
  try {
    // The one sign-out verb: every provider —
    // the same teardown /logout performs. The shallow config-and-caches
    // clear above stays ONLY as installOAuthTokens' pre-login reset
    // (installing one provider's tokens must never drop another's login).
    const { performLogout } = await import('../../commands/logout/logout.js')
    await performLogout()
  } catch (error) {
    console.error(
      `Sign-out failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  cliOk('Signed out')
}
