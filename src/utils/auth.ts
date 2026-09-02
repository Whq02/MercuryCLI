import { spawnSync, execFileSync } from 'node:child_process'
import { subprocessEnv } from './subprocessEnv.js'
import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import memoize from 'lodash-es/memoize.js'

import {
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  CLAUDE_AI_PROFILE_SCOPE,
} from '../constants/oauth.js'
import { getIsNonInteractiveSession, preferThirdPartyAuthentication } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig, checkHasTrustDialogAccepted, untrustedWorkspaceHeadless } from './config.js'
import { getGlobalConfigCacheStamp } from './config/globalConfig.js'
import { clearBetasCaches } from './betas.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import {
  getAuthConfigHomeDir,
  getAuthScope,
  isBareMode,
  isEnvTruthy,
} from './envUtils.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { lock } from './lockfile.js'
import { logError } from './log.js'
import { loginShadowWarningFor } from './loginShadow.js'
import {
  clearKeychainCache,
  clearLegacyApiKeyPrefetch,
  ensureKeychainPrefetchCompleted,
  getLegacyApiKeyPrefetchResult,
  getMacOsKeychainStorageServiceName,
  getSecureStorage,
  getUsername,
} from './secureStorage/index.js'
import { getApiKeyHelperFromOutsideCheckoutSources, getSettingsForSource, getSettings_DEPRECATED } from './settings/settings.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import { normalizeApiKeyForConfig } from './authPortable.js'
import {
  isInvalidGrantError,
  isOAuthTokenExpired,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo as storeAccount,
} from '../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../services/oauth/getOauthProfile.js'
import type { OAuthTokens, SubscriptionType, RateLimitTier } from '../services/oauth/types.js'
import { binaryName } from './config.js'


export function isAnthropicAuthEnabled(): boolean {
  if (isBareMode()) return false

  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return Boolean(process.env.MERCURY_OAUTH_TOKEN)
  }

  if (process.env.ANTHROPIC_AUTH_TOKEN) return false
  if (getSettings_DEPRECATED().apiKeyHelper) return false
  if (process.env.MERCURY_API_KEY_FILE_DESCRIPTOR) return false
  try {
    const { source } = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
    if (source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper') return false
  } catch {
  }
  return true
}


export type AnthropicActiveSource = 'subscription' | 'api-key'

export function readAnthropicPreferredSource(): AnthropicActiveSource | undefined {
  return getGlobalConfig().anthropicPreferredSource
}

export function writeAnthropicPreferredSource(kind: AnthropicActiveSource | null): void {
  saveGlobalConfig(current => {
    const next = { ...current }
    if (kind === null) delete next.anthropicPreferredSource
    else next.anthropicPreferredSource = kind
    return next
  })
}

function subscriptionYieldsToManagedKey(): boolean {
  try {
    if (getGlobalConfig().anthropicPreferredSource !== 'api-key') return false
    return getApiKeyFromConfigOrMacOSKeychain() !== null
  } catch {
    return false
  }
}

export type AuthTokenSource =
  | 'apiKeyHelper'
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'MERCURY_OAUTH_TOKEN'
  | 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR'
  | 'claude.ai'
  | 'none'

export function getAuthTokenSource(): { source: AuthTokenSource; hasToken: boolean } {
  const wrap = (source: AuthTokenSource): { source: AuthTokenSource; hasToken: boolean } => ({
    source,
    hasToken: source !== 'none',
  })
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper ? wrap('apiKeyHelper') : wrap('none')
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) return wrap('ANTHROPIC_AUTH_TOKEN')
  if (process.env.MERCURY_OAUTH_TOKEN) return wrap('MERCURY_OAUTH_TOKEN')
  if (getOAuthTokenFromFileDescriptor() !== null) {
    return wrap('MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR')
  }
  if (getConfiguredApiKeyHelper()) return wrap('apiKeyHelper')
  const tokens = getClaudeAIOAuthTokens()
  if (
    tokens?.accessToken &&
    shouldUseClaudeAIAuth(tokens.scopes) &&
    !subscriptionYieldsToManagedKey()
  ) {
    return wrap('claude.ai')
  }
  return wrap('none')
}

export function loginShadowWarning(): string | null {
  return loginShadowWarningFor(getAuthTokenSource().source)
}


export type ApiKeySource = 'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/logins managed key' | 'none'

function isCiOrTest(): boolean {
  return isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test'
}

export function getAnthropicApiKeyWithSource(opts?: {
  skipRetrievingKeyFromApiKeyHelper?: boolean
}): { key: string | null; source: ApiKeySource } {
  const skipHelper = opts?.skipRetrievingKeyFromApiKeyHelper === true

  if (isBareMode()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
    }
    if (getSettingsForSource('flagSettings')?.apiKeyHelper) {
      if (skipHelper) return { key: null, source: 'apiKeyHelper' }
      return { key: getApiKeyFromApiKeyHelperCached(), source: 'apiKeyHelper' }
    }
    return { key: null, source: 'none' }
  }

  if (preferThirdPartyAuthentication() && process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  }

  if (isCiOrTest()) {
    const fromFd = getApiKeyFromFileDescriptor()
    if (fromFd !== null) return { key: fromFd, source: 'ANTHROPIC_API_KEY' }
    const keyVar = process.env.ANTHROPIC_API_KEY
    const hasTokenVar = Boolean(
      process.env.MERCURY_OAUTH_TOKEN ||
        process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR ||
        process.env.ANTHROPIC_AUTH_TOKEN,
    )
    if (!keyVar && !hasTokenVar) {
      throw new Error(
        'No credential found. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or MERCURY_OAUTH_TOKEN to run in this environment.',
      )
    }
    if (keyVar) return { key: keyVar, source: 'ANTHROPIC_API_KEY' }
    return { key: null, source: 'none' }
  }

  if (process.env.ANTHROPIC_API_KEY && isCustomApiKeyApproved(process.env.ANTHROPIC_API_KEY)) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  }

  const fromFd = getApiKeyFromFileDescriptor()
  if (fromFd !== null) return { key: fromFd, source: 'ANTHROPIC_API_KEY' }

  if (getConfiguredApiKeyHelper()) {
    if (skipHelper) return { key: null, source: 'apiKeyHelper' }
    return { key: getApiKeyFromApiKeyHelperCached(), source: 'apiKeyHelper' }
  }

  const managed = getApiKeyFromConfigOrMacOSKeychain()
  if (managed) return { key: managed, source: '/logins managed key' }

  return { key: null, source: 'none' }
}

export function getAnthropicApiKey(): string | null {
  return getAnthropicApiKeyWithSource().key
}

export function hasFirstPartyCredential(): boolean {
  try {
    return (
      getAuthTokenSource().hasToken ||
      getAnthropicApiKeyWithSource().source !== 'none' ||
      Boolean(process.env.ANTHROPIC_API_KEY)
    )
  } catch {
    return false
  }
}

export function hasAnthropicApiKeyAuth(): boolean {
  try {
    return getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).key !== null
  } catch {
    return false
  }
}

export function isCustomApiKeyApproved(key: string): boolean {
  const approved = getGlobalConfig().customApiKeyResponses?.approved ?? []
  return approved.includes(normalizeApiKeyForConfig(key))
}


export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) return getSettingsForSource('flagSettings')?.apiKeyHelper
  if (untrustedWorkspaceHeadless()) return getApiKeyHelperFromOutsideCheckoutSources()
  return getSettings_DEPRECATED().apiKeyHelper
}

const DEFAULT_HELPER_TTL_MS = 5 * 60 * 1000

export function calculateApiKeyHelperTTL(): number {
  const raw = process.env.MERCURY_API_KEY_HELPER_TTL_MS
  if (!raw) return DEFAULT_HELPER_TTL_MS
  const value = parseInt(raw, 10)
  if (Number.isNaN(value) || value < 0) {
    logError(`MERCURY_API_KEY_HELPER_TTL_MS is not a non-negative integer: ${raw}`)
    return DEFAULT_HELPER_TTL_MS
  }
  return value
}

const HELPER_SENTINEL = ' '

type HelperCache = {
  value: string | null
  fetchedAt: number
  epoch: number
  inFlight: { promise: Promise<string | null>; isBackground: boolean; startedAt: number } | null
  failure: { message: string; at: number } | null
}

const helperCache: HelperCache = { value: null, fetchedAt: 0, epoch: 0, inFlight: null, failure: null }

function publicHelperValue(value: string | null): string | null {
  return value === HELPER_SENTINEL ? null : value
}

export function getApiKeyFromApiKeyHelperCached(): string | null {
  return publicHelperValue(helperCache.value)
}

export function getApiKeyHelperFailure(): { message: string; at: number } | null {
  return helperCache.failure
}

export function apiKeyHelperFailedLast(): boolean {
  return getConfiguredApiKeyHelper() !== undefined && helperCache.failure !== null
}

export function clearApiKeyHelperCache(): void {
  helperCache.epoch++
  helperCache.value = null
  helperCache.fetchedAt = 0
  helperCache.inFlight = null
}

export function getApiKeyHelperElapsedMs(): number {
  const inFlight = helperCache.inFlight
  if (inFlight === null || inFlight.isBackground) return 0
  return Date.now() - inFlight.startedAt
}

function execOutcomeTimedOut(error: string | undefined): boolean {
  return error !== undefined && /timed out/i.test(error)
}

async function executeApiKeyHelper(helper: string): Promise<string> {
  const result = await execFileNoThrowWithCwd(helper, [], {
    shell: true,
    timeout: 10 * 60_000,
    preserveOutputOnError: true,
    cwd: getCwd(),
  })
  if (result.code !== 0) {
    const stderr = result.stderr.trim()
    const why = execOutcomeTimedOut(result.error) ? 'timed out' : `exited with code ${result.code}`
    throw new Error(`apiKeyHelper ${why}${stderr ? `: ${stderr}` : ''}`)
  }
  const value = result.stdout.trim()
  if (value === '') throw new Error('apiKeyHelper returned no value')
  return value
}

function helperBlockedByTrust(): boolean {
  const configured = getConfiguredApiKeyHelper()
  if (!configured) return false
  const fromProjectScope =
    configured === getSettingsForSource('projectSettings')?.apiKeyHelper ||
    configured === getSettingsForSource('localSettings')?.apiKeyHelper
  if (!fromProjectScope) return false
  if (getIsNonInteractiveSession()) return false
  return !checkHasTrustDialogAccepted()
}

export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  void isNonInteractiveSession
  const helper = getConfiguredApiKeyHelper()
  if (!helper) return null

  if (helperBlockedByTrust()) {
    logError(
      `The apiKeyHelper was invoked before workspace trust was confirmed and was not executed. ${binaryName()} — report issues via /feedback.`,
    )
    return null
  }

  const now = Date.now()
  const ttl = calculateApiKeyHelperTTL()
  const fresh = helperCache.value !== null && now - helperCache.fetchedAt < ttl

  if (fresh) return publicHelperValue(helperCache.value)

  if (helperCache.value !== null) {
    if (helperCache.inFlight === null) {
      startHelperExecution(helper, true)
    }
    return publicHelperValue(helperCache.value)
  }

  if (helperCache.inFlight === null) {
    startHelperExecution(helper, false)
  }
  return helperCache.inFlight?.promise ?? null
}

function startHelperExecution(helper: string, isBackground: boolean): void {
  const epoch = helperCache.epoch
  const promise = (async (): Promise<string | null> => {
    try {
      const value = await executeApiKeyHelper(helper)
      if (helperCache.epoch === epoch) {
        helperCache.value = value
        helperCache.fetchedAt = Date.now()
      }
      helperCache.failure = null
      return value
    } catch (error) {
      if (getIsNonInteractiveSession()) {
        process.stderr.write(`\x1b[31mapiKeyHelper failed: ${errorMessage(error)}\x1b[0m\n`)
      }
      logError(error)
      helperCache.failure = { message: errorMessage(error), at: Date.now() }
      if (helperCache.epoch === epoch) {
        if (helperCache.value !== null && helperCache.value !== HELPER_SENTINEL) {
          helperCache.fetchedAt = Date.now()
        } else {
          helperCache.value = HELPER_SENTINEL
          helperCache.fetchedAt = Date.now()
        }
      }
      return helperCache.epoch === epoch ? publicHelperValue(helperCache.value) : null
    } finally {
      if (helperCache.epoch === epoch) helperCache.inFlight = null
    }
  })()
  helperCache.inFlight = { promise, isBackground, startedAt: Date.now() }
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(isNonInteractiveSession: boolean): void {
  if (!getConfiguredApiKeyHelper()) return
  if (helperBlockedByTrust()) return
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}


let signedOutKeyMemoStamp: number | null = null
let signedOutOAuthMemoStamp: number | null = null

export const getApiKeyFromConfigOrMacOSKeychain = memoize((): string | null => {
  const key = readManagedKey()
  signedOutKeyMemoStamp = key === null ? getGlobalConfigCacheStamp() : null
  return key
})

function readManagedKey(): string | null {
  if (isBareMode()) return null
  if (process.platform === 'darwin') {
    const prefetch = getLegacyApiKeyPrefetchResult()
    if (prefetch !== null) {
      if (prefetch.stdout) return prefetch.stdout.trim()
      return getGlobalConfig().primaryApiKey ?? null
    }
    try {
      const result = readKeychainSync()
      if (result !== null) return result
    } catch (error) {
      logError(error)
    }
  }
  return getGlobalConfig().primaryApiKey ?? null
}

function readKeychainSync(): string | null {
  const out = execFileSync(
    'security',
    ['find-generic-password', '-a', getUsername(), '-s', getMacOsKeychainStorageServiceName(), '-w'],
    { windowsHide: true, encoding: 'utf-8', timeout: 10_000, env: { ...subprocessEnv() } },
  )
  const trimmed = out.trim()
  return trimmed === '' ? null : trimmed
}

const API_KEY_FORMAT_RE = /^[A-Za-z0-9_-]+$/

export async function saveApiKey(key: string): Promise<void> {
  if (!API_KEY_FORMAT_RE.test(key)) {
    throw new Error('Invalid API key format: only letters, digits, dashes and underscores are allowed')
  }
  if (process.platform === 'darwin') {
    try {
      const { maybeRemoveApiKeyFromMacOSKeychainThrows } = await import('./authPortable.js')
      await maybeRemoveApiKeyFromMacOSKeychainThrows()
    } catch (error) {
      logError(error)
    }
  }
  let keychainWritten = false
  if (process.platform === 'darwin') {
    keychainWritten = writeKeychainHexStdin(key)
  }
  saveGlobalConfig(current => {
    const responses = current.customApiKeyResponses ?? { approved: [], rejected: [] }
    const normalized = normalizeApiKeyForConfig(key)
    const approved = responses.approved ?? []
    return {
      ...current,
      ...(keychainWritten ? {} : { primaryApiKey: key }),
      customApiKeyResponses: {
        approved: approved.includes(normalized) ? approved : [...approved, normalized],
        rejected: responses.rejected ?? [],
      },
    }
  })
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
}

function writeKeychainHexStdin(key: string): boolean {
  try {
    const hex = Buffer.from(key, 'utf-8').toString('hex')
    const commandLine = `add-generic-password -U -a "${getUsername()}" -s "${getMacOsKeychainStorageServiceName()}" -X ${hex}\n`
    spawnSync('security', ['-i'], { windowsHide: true, input: commandLine, encoding: 'utf-8', timeout: 10_000, env: { ...subprocessEnv() } })
    return true
  } catch {
    return false
  }
}

export async function removeApiKey(): Promise<void> {
  if (process.platform === 'darwin') {
    try {
      const { maybeRemoveApiKeyFromMacOSKeychainThrows } = await import('./authPortable.js')
      await maybeRemoveApiKeyFromMacOSKeychainThrows()
    } catch (error) {
      logError(error)
    }
  }
  saveGlobalConfig(current => ({ ...current, primaryApiKey: undefined }))
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
}


type UnsavedRefresh = { tokens: OAuthTokens; supersedes: string; warning: string; at: number }
let unsavedRefresh: UnsavedRefresh | null = null

export function getOAuthRefreshSaveFailure(): { warning: string; at: number } | null {
  return unsavedRefresh === null ? null : { warning: unsavedRefresh.warning, at: unsavedRefresh.at }
}

export function __resetUnsavedRefreshForTest(): void {
  unsavedRefresh = null
}

function overlayUnsavedRefresh(stored: OAuthTokens | null): OAuthTokens | null {
  const held = unsavedRefresh
  if (held === null) return stored
  if (stored !== null && stored.refreshToken === held.supersedes) return held.tokens
  unsavedRefresh = null
  return stored
}

function holdUnsavedRefresh(
  tokens: OAuthTokens,
  superseded: OAuthTokens,
  verdict: { warning?: string; code?: string },
): void {
  const supersedes =
    unsavedRefresh !== null && superseded === unsavedRefresh.tokens
      ? unsavedRefresh.supersedes
      : (superseded.refreshToken ?? '')
  const warning =
    `the refreshed claude.ai credential could not be saved${verdict.code ? ` (${verdict.code})` : ''}` +
    `${verdict.warning ? `: ${verdict.warning}` : ''} — this session runs on the fresh token and the next ` +
    'refresh retries the save; a new sign-in is needed if it never lands before this process exits'
  unsavedRefresh = { tokens, supersedes, warning, at: Date.now() }
  logError(new Error(`OAuth refresh: ${warning}`))
}

function synthesizedEnvToken(accessToken: string): OAuthTokens {
  return {
    accessToken,
    refreshToken: null,
    expiresAt: null,
    scopes: [CLAUDE_AI_INFERENCE_SCOPE],
    subscriptionType: null,
    rateLimitTier: null,
  }
}

export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => {
  const tokens = readStoredOAuthTokens()
  signedOutOAuthMemoStamp = tokens === null ? getGlobalConfigCacheStamp() : null
  return tokens
})

function readStoredOAuthTokens(): OAuthTokens | null {
  if (isBareMode()) return null
  if (process.env.MERCURY_OAUTH_TOKEN) {
    return synthesizedEnvToken(process.env.MERCURY_OAUTH_TOKEN)
  }
  const fromFd = getOAuthTokenFromFileDescriptor()
  if (fromFd !== null) return synthesizedEnvToken(fromFd)
  try {
    const stored = getSecureStorage().read()?.claudeAiOauth
    return overlayUnsavedRefresh(stored?.accessToken ? stored : null)
  } catch (error) {
    logError(error)
  }
  return null
}

export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  if (isBareMode()) return null
  if (process.env.MERCURY_OAUTH_TOKEN) {
    return synthesizedEnvToken(process.env.MERCURY_OAUTH_TOKEN)
  }
  const fromFd = getOAuthTokenFromFileDescriptor()
  if (fromFd !== null) return synthesizedEnvToken(fromFd)
  try {
    const data = await getSecureStorage().readAsync()
    const stored = data?.claudeAiOauth
    return overlayUnsavedRefresh(stored?.accessToken ? stored : null)
  } catch (error) {
    logError(error)
  }
  return null
}

export function hasStoredOAuthToken(): boolean {
  try {
    return getSecureStorage().read()?.claudeAiOauth?.accessToken !== undefined
  } catch {
    return false
  }
}

export function clearOAuthTokenCache(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
}

export function dropCredentialMemos(): void {
  clearOAuthTokenCache()
  signedOutOAuthMemoStamp = null
  signedOutKeyMemoStamp = null
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
  clearBetasCaches()
  clearToolSchemaCache()
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
    clearBetasCaches()
    clearToolSchemaCache()
    if (result.success) unsavedRefresh = null
    return result
  } catch (error) {
    logError(error)
    return { success: false, warning: 'Failed to save credentials to secure storage' }
  }
}


const knownDeadRefreshTokens = new Set<string>()

export function isOAuthRefreshKnownDead(): boolean {
  const refresh = getClaudeAIOAuthTokens()?.refreshToken
  if (refresh === undefined || refresh === null) return false
  if (refresh === '') return true
  return knownDeadRefreshTokens.has(refresh)
}

export function __resetKnownDeadRefreshTokensForTest(): void {
  knownDeadRefreshTokens.clear()
}

export function isAnthropicOAuthSignInExpired(): boolean {
  try {
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens) return false
    if (getAuthTokenSource().source !== 'claude.ai') return false
    if (isOAuthRefreshKnownDead()) return true
    return isOAuthTokenExpired(tokens.expiresAt) && !tokens.refreshToken
  } catch {
    return false
  }
}


function credentialsFilePath(): string {
  return join(getAuthConfigHomeDir(), '.credentials.json')
}

let lastCredentialsMtimeMs: number | null = null

function invalidateOnDiskChange(): void {
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
  const stamp = getGlobalConfigCacheStamp()
  if (signedOutKeyMemoStamp !== null && stamp !== signedOutKeyMemoStamp) {
    signedOutKeyMemoStamp = null
    getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
    clearLegacyApiKeyPrefetch()
  }
  if (signedOutOAuthMemoStamp !== null && stamp !== signedOutOAuthMemoStamp) {
    signedOutOAuthMemoStamp = null
    clearOAuthTokenCache()
  }
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

  const lockDir = getAuthConfigHomeDir()
  let release: () => Promise<void>
  try {
    mkdirSync(lockDir, { recursive: true })
    release = await lock(lockDir, { realpath: false })
  } catch (error) {
    if ((error as { code?: string }).code === 'ELOCKED') {
      if (retryCount < MAX_LOCK_RETRIES) {
        await new Promise(resolvePromise => {
          const timer = setTimeout(resolvePromise, 1000 + randomInt(1000))
          timer.unref?.()
        })
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
        knownDeadRefreshTokens.add(usedRefreshToken)
        await blankRefreshTokenOnDisk(usedRefreshToken)
      }
      return false
    }
  } finally {
    await release().catch(() => {})
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


export function getSubscriptionType(): SubscriptionType | null {
  if (!isAnthropicAuthEnabled()) return null
  const tokens = getClaudeAIOAuthTokens()
  return tokens?.subscriptionType ?? null
}

export function isClaudeAISubscriber(): boolean {
  if (!isAnthropicAuthEnabled()) return false
  const tokens = getClaudeAIOAuthTokens()
  return (
    tokens !== null &&
    shouldUseClaudeAIAuth(tokens.scopes) &&
    !subscriptionYieldsToManagedKey()
  )
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}
export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}
export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}
export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function isTeamPremiumSubscriber(): boolean {
  return getSubscriptionType() === 'team' && getRateLimitTier() === 'default_claude_max_5x'
}

export function isConsumerSubscriber(): boolean {
  const type = getSubscriptionType()
  return isClaudeAISubscriber() && (type === 'max' || type === 'pro')
}

export function hasOpusAccess(): boolean {
  const type = getSubscriptionType()
  return type === 'max' || type === 'enterprise' || type === 'team' || type === 'pro' || type === null
}

export function getRateLimitTier(): RateLimitTier | null {
  if (!isAnthropicAuthEnabled()) return null
  const tokens = getClaudeAIOAuthTokens()
  return tokens?.rateLimitTier ?? null
}

export function hasProfileScope(): boolean {
  const tokens = getClaudeAIOAuthTokens()
  return tokens?.scopes.includes(CLAUDE_AI_PROFILE_SCOPE) ?? false
}

const SUBSCRIPTION_NAMES: Record<SubscriptionType, string> = {
  enterprise: 'Claude Enterprise',
  team: 'Claude Team',
  max: 'Claude Max',
  pro: 'Claude Pro',
}

export function getSubscriptionName(): string {
  const type = getSubscriptionType()
  return type !== null ? SUBSCRIPTION_NAMES[type] : 'Claude API'
}

export function is1PApiCustomer(): boolean {
  return !isClaudeAISubscriber()
}

const OVERAGE_BILLING_TYPES = new Set([
  'stripe_subscription',
  'stripe_subscription_contracted',
  'apple_subscription',
  'google_play_subscription',
])

export function isOverageProvisioningAllowed(): boolean {
  if (!isClaudeAISubscriber()) return false
  const billing = getOauthAccountInfo()?.billingType
  return billing !== undefined && billing !== null && OVERAGE_BILLING_TYPES.has(billing)
}

const scopedAccountIdentityCache = new Map<
  string,
  ReturnType<typeof getGlobalConfig>['oauthAccount'] | null
>()

function readScopedOauthAccount(dir: string) {
  const cached = scopedAccountIdentityCache.get(dir)
  if (cached !== undefined) return cached
  let result: ReturnType<typeof getGlobalConfig>['oauthAccount'] | null = null
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))
    const account = parsed?.oauthAccount
    if (
      account &&
      typeof account.accountUuid === 'string' &&
      account.accountUuid.trim() !== ''
    ) {
      result = account
    }
  } catch {
    result = null
  }
  scopedAccountIdentityCache.set(dir, result)
  return result
}

export function getOauthAccountInfo() {
  if (!isAnthropicAuthEnabled()) return undefined
  const scopeDir = getAuthScope()
  if (scopeDir !== undefined) {
    const scoped = readScopedOauthAccount(scopeDir)
    if (scoped) return scoped
  }
  return getGlobalConfig().oauthAccount
}

export type UserAccountInfo = {
  tokenSource?: string
  subscription?: string
  apiKeySource?: string
  organization?: string
  email?: string
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
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) info.apiKeySource = apiKeySource
  if (tokenSource === 'claude.ai' || apiKeySource === '/logins managed key') {
    const account = getGlobalConfig().oauthAccount
    if (account?.organizationName) info.organization = account.organizationName
    if (account?.emailAddress) info.email = account.emailAddress
  }
  return info
}


export type OrgValidationResult = { valid: true } | { valid: false; message: string }

export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  if (process.env.ANTHROPIC_UNIX_SOCKET) return { valid: true }
  if (!isAnthropicAuthEnabled()) return { valid: true }
  const requiredOrg = getSettingsForSource('policySettings')?.forceLoginOrgUUID
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
        `This may be a network problem, or a token without the profile scope (as minted by \`${cli} setup-token\`). ` +
        `Retry, or acquire a full-scope token by running \`${cli} auth login\`.`,
    }
  }
  if (actualOrg === requiredOrg) return { valid: true }

  const envTokenVar = process.env.MERCURY_OAUTH_TOKEN
    ? 'MERCURY_OAUTH_TOKEN'
    : process.env.MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR
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


export { storeAccount as storeOAuthAccountInfo }
export { ensureKeychainPrefetchCompleted }
