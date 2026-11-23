import { randomInt } from 'node:crypto'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import {
  clearAuthCredentialMemos,
  clearOAuthTokenMemos,
  clearUnsavedRefresh,
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  getClaudeAIOAuthTokensAsync,
  getSubscriptionName,
  holdUnsavedRefresh,
  invalidateAuthMemoStamps,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
  isOAuthRefreshKnownDead,
  markKnownDeadRefreshToken,
  oauthRefreshLockSite,
  type ApiKeySource,
} from '../credentials/auth.js'
import { binaryName, getGlobalConfig } from '../../../platform/settings/config.js'
import { readGlobalConfigAgain } from '../../../platform/config/globalConfig.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { getAuthConfigHomeDir } from '../../../platform/environment/envUtils.js'
import { lock } from '../../../platform/storage/lockfile.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { clearBetasWhereKept } from '../../facts/betasClearing.js'
import { getOauthProfileFromOauthToken } from '../oauth-shapes/getOauthProfile.js'
import { isOAuthTokenExpired, shouldUseClaudeAIAuth } from '../oauth-shapes/scopes.js'
import type { OAuthTokens } from '../oauth-shapes/types.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { getSecureStorage } from '../../../platform/secure-storage/index.js'
import { getSettingsForSource } from '../../../platform/settings/settings.js'
import { sleep } from '../../../platform/async/sleep.js'
import { clearToolSchemaCache } from '../../roads/toolSchemaCache.js'
import {
  isInvalidGrantError,
  refreshOAuthToken,
  storeOAuthAccountInfo,
} from '../oauth/refresh.js'

export { storeOAuthAccountInfo }

export function clearOAuthTokenCache(): void {
  clearOAuthTokenMemos()
  const { resetProviderSnapshotMemo } = require('../../roads/modelRegistry.js') as typeof import('../../roads/modelRegistry.js')
  resetProviderSnapshotMemo()
  const { resetWalletEntriesMemo } = require('../../wallet/wallet.js') as typeof import('../../wallet/wallet.js')
  resetWalletEntriesMemo()
}

export function dropCredentialMemos(): void {
  const { resetSettingsCache } = require('../../../platform/settings/settingsCache.js') as typeof import('../../../platform/settings/settingsCache.js')
  resetSettingsCache()
  clearOAuthTokenCache()
  clearAuthCredentialMemos()
}

export function saveOAuthTokensIfNeeded(tokens: OAuthTokens): {
  success: boolean
  warning?: string
} {
  if (!shouldUseClaudeAIAuth(tokens.scopes)) return { success: true }
  if (tokens.refreshToken === null || tokens.expiresAt === null) return { success: true }
  try {
    const storage = getSecureStorage()
    const current = storage.read() ?? {}
    const previous = current.claudeAiOauth
    const result = storage.update({
      ...current,
      claudeAiOauth: {
        ...tokens,
        subscriptionType: tokens.subscriptionType ?? previous?.subscriptionType ?? null,
        rateLimitTier: tokens.rateLimitTier ?? previous?.rateLimitTier ?? null,
      },
    })
    clearOAuthTokenCache()
    clearBetasWhereKept()
    clearToolSchemaCache()
    if (result.success) clearUnsavedRefresh()
    return result
  } catch (error) {
    logError(error)
    return { success: false, warning: 'Failed to save credentials to secure storage' }
  }
}

function credentialsFilePath(): string {
  return join(getAuthConfigHomeDir(), '.credentials.json')
}

let lastCredentialsMtimeMs: number | null = null

export function invalidateOnDiskChange(): void {
  if (process.env.NODE_ENV !== 'test') readGlobalConfigAgain()
  try {
    const mtime = statSync(credentialsFilePath()).mtimeMs
    if (lastCredentialsMtimeMs === null || mtime !== lastCredentialsMtimeMs) {
      clearOAuthTokenCache()
    }
    lastCredentialsMtimeMs = mtime
  } catch {
    getClaudeAIOAuthTokens.cache?.clear?.()
    lastCredentialsMtimeMs = null
  }
  invalidateAuthMemoStamps(() => clearOAuthTokenCache())
}

let refreshInFlight: Promise<boolean> | null = null

export async function checkAndRefreshOAuthTokenIfNeeded(
  retryCount = 0,
  force = false,
): Promise<boolean> {
  if (!force && retryCount === 0 && refreshInFlight !== null) return refreshInFlight
  const run = doRefresh(retryCount, force)
  if (!force && retryCount === 0) {
    refreshInFlight = run.finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }
  return run
}

const MAX_LOCK_RETRIES = 5

async function doRefresh(retryCount: number, force: boolean): Promise<boolean> {
  invalidateOnDiskChange()
  let tokens = getClaudeAIOAuthTokens()
  if (!force) {
    if (!tokens?.refreshToken || !isOAuthTokenExpired(tokens.expiresAt)) return false
  }
  if (!tokens?.refreshToken) return false
  if (isOAuthRefreshKnownDead()) return false
  if (!shouldUseClaudeAIAuth(tokens.scopes)) return false

  clearOAuthTokenCache()
  tokens = await getClaudeAIOAuthTokensAsync()
  if (!tokens?.refreshToken) return false
  if (!force && !isOAuthTokenExpired(tokens.expiresAt)) return false
  if (isOAuthRefreshKnownDead()) return false

  const { dir: lockDir, options: lockOptions } = oauthRefreshLockSite()
  let release: () => Promise<void>
  try {
    mkdirSync(lockDir, { recursive: true })
    release = await lock(lockDir, lockOptions)
  } catch (error) {
    if ((error as { code?: string }).code === 'ELOCKED') {
      if (retryCount < MAX_LOCK_RETRIES) {
        await sleep(1000 + randomInt(1000), undefined, { unref: true })
        return checkAndRefreshOAuthTokenIfNeeded(retryCount + 1, force)
      }
      logForDebugging(`OAuth refresh: lock still held after ${MAX_LOCK_RETRIES} retries; giving up`)
      return false
    }
    logError(error)
    return false
  }

  try {
    clearOAuthTokenCache()
    const underLock = await getClaudeAIOAuthTokensAsync()
    if (!underLock?.refreshToken) return false
    if (!force && !isOAuthTokenExpired(underLock.expiresAt)) return false
    if (isOAuthRefreshKnownDead()) return false

    const usedRefreshToken = underLock.refreshToken
    try {
      const refreshed = await refreshOAuthToken(
        usedRefreshToken,
        shouldUseClaudeAIAuth(underLock.scopes) ? {} : { scopes: underLock.scopes },
      )
      const saved = saveOAuthTokensIfNeeded(refreshed)
      if (!saved.success) holdUnsavedRefresh(refreshed, underLock, saved)
      clearOAuthTokenCache()
      return true
    } catch (error) {
      logError(error)
      clearOAuthTokenCache()
      const nowStored = await getClaudeAIOAuthTokensAsync()
      if (nowStored && !isOAuthTokenExpired(nowStored.expiresAt)) return true
      if (isInvalidGrantError(error)) {
        markKnownDeadRefreshToken(usedRefreshToken)
        await blankRefreshTokenOnDisk(usedRefreshToken)
      }
      return false
    }
  } finally {
    await release().catch(passedOver)
  }
}

async function blankRefreshTokenOnDisk(usedRefreshToken: string): Promise<void> {
  try {
    const storage = getSecureStorage()
    const current = storage.read()
    const stored = current?.claudeAiOauth
    if (!stored || stored.refreshToken !== usedRefreshToken) return
    const result = storage.update({
      ...(current ?? {}),
      claudeAiOauth: { ...stored, refreshToken: '' },
    })
    if (!result.success) logError('Failed to blank the dead refresh token on disk')
  } catch (error) {
    logError(error)
  }
}

const in401 = new Map<string, Promise<boolean>>()

export async function handleOAuth401Error(failedAccessToken: string): Promise<boolean> {
  const existing = in401.get(failedAccessToken)
  if (existing !== undefined) return existing
  const run = (async (): Promise<boolean> => {
    clearOAuthTokenCache()
    const tokens = await getClaudeAIOAuthTokensAsync()
    if (!tokens?.refreshToken) return false
    if (tokens.accessToken !== failedAccessToken) return true
    return checkAndRefreshOAuthTokenIfNeeded(0, true)
  })().finally(() => {
    in401.delete(failedAccessToken)
  })
  in401.set(failedAccessToken, run)
  return run
}

type UserAccountInfo = {
  tokenSource?: string
  subscription?: string
  apiKeySource?: string
  organization?: string
  email?: string
}

function readApiKeyOrNone(): { key: string | null; source: ApiKeySource } {
  try {
    return getAnthropicApiKeyWithSource()
  } catch {
    return { key: null, source: 'none' }
  }
}

export function getAccountInformation(): UserAccountInfo | null {
  const info: UserAccountInfo = {}
  const { source: tokenSource } = getAuthTokenSource()
  if (
    tokenSource === 'MERCURY_OAUTH_TOKEN' ||
    tokenSource === 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR'
  ) {
    info.tokenSource = tokenSource
  } else if (isClaudeAISubscriber()) {
    info.subscription = getSubscriptionName()
  } else {
    info.tokenSource = tokenSource
  }
  const { key: apiKey, source: apiKeySource } = readApiKeyOrNone()
  if (apiKey) info.apiKeySource = apiKeySource
  if (tokenSource === 'claude.ai' || apiKeySource === '/logins managed key') {
    const account = getGlobalConfig().oauthAccount
    if (account?.organizationName) info.organization = account.organizationName
    const email = tokenSource === 'claude.ai' ? anthropicSignInEmailLazily() : account?.emailAddress
    if (email) info.email = email
  }
  return info
}

function anthropicSignInEmailLazily(): string | undefined {
  const { anthropicSignInEmail } =
    require('../../roads/providerUsage.js') as typeof import('../../roads/providerUsage.js')
  return anthropicSignInEmail()
}

type OrgValidationResult = { valid: true } | { valid: false; message: string }

export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  if (flagEnv('MERCURY_API_UNIX_SOCKET')) return { valid: true }
  if (!isAnthropicAuthEnabled()) return { valid: true }
  const requiredOrg = getSettingsForSource('policySettings')?.credentials?.organisation
  if (!requiredOrg) return { valid: true }

  await checkAndRefreshOAuthTokenIfNeeded()
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) return { valid: true }

  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  const actualOrg = profile?.organization?.uuid
  const cli = binaryName()
  if (!actualOrg) {
    return {
      valid: false,
      message:
        `Could not verify your organization. This machine is pinned to organization ${requiredOrg}. ` +
        `This may be a network problem, or a token without the profile scope (as minted by \`${cli} auth mint\`). ` +
        `Retry, or acquire a full-scope token by running \`${cli} auth login\`.`,
    }
  }
  if (actualOrg === requiredOrg) return { valid: true }

  const envTokenVar = flagEnv('MERCURY_OAUTH_TOKEN')
    ? 'MERCURY_OAUTH_TOKEN'
    : flagEnv('MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR')
      ? 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR'
      : null
  if (envTokenVar !== null) {
    return {
      valid: false,
      message:
        `${envTokenVar} carries a token for a different organization (${actualOrg}) than this machine's managed settings require (${requiredOrg}). ` +
        `Unset ${envTokenVar}, or replace its token with one for organization ${requiredOrg}.`,
    }
  }
  return {
    valid: false,
    message:
      `Your token belongs to organization ${actualOrg}, but this machine requires ${requiredOrg}. ` +
      `Run \`${cli} auth login\` with the correct organization.`,
  }
}
