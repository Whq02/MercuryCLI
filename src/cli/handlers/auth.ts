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

function logoutPreservingOnboarding(): void {
  saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
  clearOAuthTokenCache()
  clearApiKeyHelperCache()
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  try {
    const { resetLimitsForCredentialSwitch } =
      require('../../services/claudeAiLimits.js') as typeof import('../../services/claudeAiLimits.js')
    resetLimitsForCredentialSwitch()
  } catch {
  }
}

export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  logoutPreservingOnboarding()

  const rawProfile = tokens.profile
  const fetched =
    rawProfile === undefined ? await fetchProfileInfo(tokens.accessToken) : null
  const profile = rawProfile ?? fetched?.profile
  if (profile) {
    const account: AccountInfo = {
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
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
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      ...(tokens.tokenAccount.organizationUuid
        ? { organizationUuid: tokens.tokenAccount.organizationUuid }
        : {}),
    })
  }

  const saved = saveOAuthTokensIfNeeded(tokens)
  if (!saved.success) {
    throw new Error(saved.warning ?? 'the credential could not be saved to secure storage')
  }
  clearOAuthTokenCache()

  try {
    await fetchAndStoreUserRoles(tokens.accessToken)
  } catch (error) {
    logError(error)
  }

  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        'The server accepted the API key request but returned no key',
      )
    }
  }

  recordSignIn('anthropic', shouldUseClaudeAIAuth(tokens.scopes) ? 'oauth' : 'api-key')

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
}): Promise<void> {
  const forcedMethod = getInitialSettings().forceLoginMethod
  const loginWithClaudeAi = forcedMethod
    ? forcedMethod === 'claudeai'
    : !opts.console
  const forcedOrgUUID = getInitialSettings().forceLoginOrgUUID

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
      try {
        writeSync(1, 'Signed in with the environment refresh token\n')
        const shadow = loginShadowWarning()
        if (shadow) writeSync(1, `${shadow}\n`)
      } catch {
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

export async function authStatus(opts: { json?: boolean }): Promise<void> {
  const readable = opts.json !== true && process.stdout.isTTY === true
  const tokenSource = getAuthTokenSource()
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

  if (readable) {
    const properties = [...buildAccountProperties(), ...buildAPIProviderProperties()]
    let printed = 0
    for (const property of properties) {
      const value = property.value
      if (value === null || value === undefined || value === 'none') continue
      const rendered = propertyValueToText(value)
      if (!rendered || rendered === 'none') continue
      printed++
      try {
        writeSync(1, property.label ? `${property.label}: ${rendered}\n` : `${rendered}\n`)
      } catch {
      }
    }
    if (printed === 0 && envApiKeyPresent) {
      try {
        writeSync(1, 'API key from ANTHROPIC_API_KEY\n')
      } catch {
      }
    }
    const others = routed.rows.filter(row => row.id !== 'anthropic' && row.present)
    for (const row of others) {
      try {
        writeSync(1, `${row.id}: ${row.identity ?? row.source}\n`)
      } catch {
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
      }
    }
  } else {
    const payload: Record<string, unknown> = {
      loggedIn,
      authMethod,
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
    payload.routedProvider = routed.family
    payload.providers = routed.rows
    try {
      writeSync(1, `${jsonStringify(payload, undefined, 2)}\n`)
    } catch {
    }
  }
  process.exit(routed.family === 'anthropic' ? (loggedIn ? 0 : 1) : routed.present ? 0 : 1)
}

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
        return []
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
    return { family: 'anthropic', present: anthropicPresent, rows: [] }
  }
}

export async function authLogout(): Promise<void> {
  try {
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
