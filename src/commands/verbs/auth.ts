import { writeSync } from 'node:fs'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { cliOk } from './exit.js'
import {
  clearApiKeyHelperCache,
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getSubscriptionType,
  loginShadowWarning,
} from '../../models/sign-in/credentials/auth.js'
import { clearOAuthTokenCache, saveOAuthTokensIfNeeded, validateForceLoginOrg } from '../../models/sign-in/lifecycle/oauthLifecycle.js'
import {
  binaryName,
  getGlobalConfig,
  saveGlobalConfig,
  type AccountInfo,
} from '../../platform/settings/config.js'
import { logError } from '../../platform/logs/errorLog.js'
import { recordSignIn } from '../../models/sign-in/account-ledger/signInLedger.js'
import { OAuthService } from '../../models/sign-in/oauth/index.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  fetchProfileInfo,
  refreshSignInGrant,
  parseScopes,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../models/sign-in/oauth/client.js'
import {
  awaitStoredOAuthDaemonRestart,
  daemonRestartFailedNotice,
} from '../../models/sign-in/oauth/refresh.js'
import type { OAuthTokens } from '../../models/sign-in/oauth-shapes/types.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
  propertyValueToText,
} from './status.js'
import { maybeMarkProjectOnboardingComplete } from '../../boot/projectOnboarding.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'

function logoutPreservingOnboarding(): void {
  saveGlobalConfig(current => ({ ...current, oauthAccount: undefined }))
  clearOAuthTokenCache()
  clearApiKeyHelperCache()
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  try {
    const { resetLimitsForCredentialSwitch } =
      require('../../models/roads/anthropic/anthropicLimits.js') as typeof import('../../models/roads/anthropic/anthropicLimits.js')
    resetLimitsForCredentialSwitch()
  } catch (error) {
    passedOver(error)
  }
}

export async function installOAuthTokens(tokens: OAuthTokens): Promise<{ daemonRestartError?: string }> {
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
  const daemonRestartError = await awaitStoredOAuthDaemonRestart()
  return daemonRestartError !== null ? { daemonRestartError } : {}
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
  const forcedMethod = getInitialSettings().credentials?.signInRoute
  const loginWithClaudeAi = forcedMethod
    ? forcedMethod === 'claudeai'
    : !opts.console
  const forcedOrgUUID = getInitialSettings().credentials?.organisation

  const envRefreshToken = flagEnv('MERCURY_OAUTH_REFRESH_TOKEN')
  if (envRefreshToken) {
    const scopesRaw = flagEnv('MERCURY_OAUTH_SCOPES')
    if (!scopesRaw) {
      console.error(
        'MERCURY_OAUTH_SCOPES must be set to the space-separated scope list the refresh token was issued with (for example "org:create_api_key user:profile user:inference").',
      )
      process.exit(1)
    }
    try {
      const tokens = await refreshSignInGrant(envRefreshToken, {
        scopes: parseScopes(scopesRaw),
      })
      const installed = await installOAuthTokens(tokens)
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
        if (installed.daemonRestartError !== undefined) {
          writeSync(1, `${daemonRestartFailedNotice(installed.daemonRestartError)}\n`)
        }
      } catch (error) {
        passedOver(error)
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
    const installed = await installOAuthTokens(tokens)
    const validation = await validateForceLoginOrg()
    if (!validation.valid) {
      console.error(validation.message)
      process.exit(1)
    }
    try {
      writeSync(1, 'Signed in\n')
      const shadow = loginShadowWarning()
      if (shadow) writeSync(1, `${shadow}\n`)
      if (installed.daemonRestartError !== undefined) {
        writeSync(1, `${daemonRestartFailedNotice(installed.daemonRestartError)}\n`)
      }
    } catch (error) {
      passedOver(error)
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

import { readSignInRefusal, signInRefusalWords, type SignInRefusal } from '../../models/roads/signInRefusal.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

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
  const envApiKeyPresent = Boolean(hostEnv().ANTHROPIC_API_KEY)
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
      : tokenSource.hasToken && tokenSource.source === 'credentials.keyCommand'
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
    const anthropicRefusal = routed.rows.find(row => row.id === 'anthropic')?.refused
    if (anthropicRefusal) writeSync(1, `anthropic: ${signInRefusalWords(anthropicRefusal, 'anthropic')}\n`)
    for (const property of properties) {
      const value = property.value
      if (value === null || value === undefined || value === 'none') continue
      const rendered = propertyValueToText(value)
      if (!rendered || rendered === 'none') continue
      printed++
      try {
        writeSync(1, property.label ? `${property.label}: ${rendered}\n` : `${rendered}\n`)
      } catch (error) {
        passedOver(error)
      }
    }
    if (printed === 0 && envApiKeyPresent) {
      try {
        writeSync(1, 'API key from ANTHROPIC_API_KEY\n')
      } catch (error) {
        passedOver(error)
      }
    }
    const others = routed.rows.filter(row => row.id !== 'anthropic' && row.present)
    for (const row of others) {
      try {
        writeSync(1, `${row.id}: ${row.refused ? signInRefusalWords(row.refused, row.id) : row.identity ?? row.source}\n`)
      } catch (error) {
        passedOver(error)
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
      } catch (error) {
        passedOver(error)
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
      payload.email = (tokenSource.source === 'claude.ai' ? signInEmail() : account?.emailAddress) ?? null
      payload.orgId = account?.organizationUuid ?? null
      payload.orgName = account?.organizationName ?? null
      payload.subscriptionType = subscriptionType ?? null
    }
    payload.routedProvider = routed.family
    payload.providers = routed.rows
    try {
      writeSync(1, `${jsonStringify(payload, undefined, 2)}\n`)
    } catch (error) {
      passedOver(error)
    }
  }
  process.exit(routed.present ? 0 : 1)
}

function signInEmail(): string | undefined {
  const { anthropicSignInEmail } =
    require('../../models/roads/providerUsage.js') as typeof import('../../models/roads/providerUsage.js')
  return anthropicSignInEmail()
}

function routedProviderRows(anthropicPresent: boolean): {
  family: string
  present: boolean
  rows: Array<{ id: string; kind: string; source: string; present: boolean; identity?: string; refused?: SignInRefusal; status?: string }>
} {
  try {
    const { declaredRouteOf } = require('../../models/roads/routeLaw.js') as typeof import('../../models/roads/routeLaw.js')
    const { getEngineModel } = require('../../models/catalogue/engineModel.js') as typeof import('../../models/catalogue/engineModel.js')
    const { buildProviderSnapshot } = require('../../models/roads/modelRegistry.js') as typeof import('../../models/roads/modelRegistry.js')
    const { providerFamilyPresences } =
      require('../../models/roads/providerUsage.js') as typeof import('../../models/roads/providerUsage.js')
    const { sessionAccountFamily } =
      require('../../models/sign-in/accounts/sessionAccount.js') as typeof import('../../models/sign-in/accounts/sessionAccount.js')
    const engineModel = getEngineModel()
    const family = sessionAccountFamily(engineModel) ?? declaredRouteOf(engineModel) ?? 'anthropic'
    const snapshot = buildProviderSnapshot()
    const presences = ((): ReturnType<typeof providerFamilyPresences> => {
      try {
        return providerFamilyPresences(snapshot.providers)
      } catch (error) {
        passedOver(error)
        return []
      }
    })()
    const rows = snapshot.providers.map(provider => {
      const account = provider.description.account
      const present = provider.id === 'anthropic' ? anthropicPresent : account.kind !== 'none'
      const identity = presences.find(presence => presence.id === provider.id)?.identity
      const refused = present ? readSignInRefusal(provider.id) : undefined
      return {
        id: provider.id,
        kind: account.kind,
        source: account.label,
        present,
        ...(refused ? { refused, status: signInRefusalWords(refused, provider.id) } : {}),
        ...(identity !== undefined ? { identity } : {}),
      }
    })
    const routedRow = rows.find(row => row.id === family)
    return { family, present: (routedRow?.present ?? false) && !routedRow?.refused, rows }
  } catch {
    return { family: 'anthropic', present: anthropicPresent, rows: [] }
  }
}

export async function authLogout(): Promise<void> {
  let refused: string[]
  try {
    const { signOutRefusals } = await import('../logout/logout.js')
    refused = await signOutRefusals()
  } catch (error) {
    console.error(
      `Sign-out failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
  if (refused.length > 0) {
    console.error(refused.join('\n'))
    process.exit(1)
  }
  cliOk('Signed out')
}
