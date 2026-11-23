import { spawnSync } from 'node:child_process'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { subprocessEnv } from '../../../platform/processes/subprocessEnv.js'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { noteCredentialChange } from '../account-ledger/signInLedger.js'
import { scopeIdentityFile } from '../account-ledger/scopeScan.js'

import memoize from 'lodash-es/memoize.js'

import {
  INFERENCE_SCOPE,
  PROFILE_SCOPE,
} from '../oauth/oauth.js'
import { getIsNonInteractiveSession, preferThirdPartyAuthentication } from '../../../boot/process-state/processState.js'
import { getGlobalConfig, saveGlobalConfig, checkHasTrustDialogAccepted, untrustedWorkspaceHeadless } from '../../../platform/settings/config.js'
import { getGlobalConfigCacheStamp, isConfigReadingAllowed } from '../../../platform/config/globalConfig.js'
import { clearBetasWhereKept } from '../../facts/betasClearing.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { errorMessage } from '../../../platform/errors/errors.js'
import {
  getAuthConfigHomeDir,
  getAuthScope,
  isBareMode,
  isEnvTruthy,
} from '../../../platform/environment/envUtils.js'
import { execFileNoThrowWithCwd } from '../../../platform/processes/execFileNoThrow.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { loginShadowWarningFor } from './loginShadow.js'
import {
  clearCredentialStoreReadError,
  clearKeychainCache,
  clearLegacyApiKeyPrefetch,
  ensureKeychainPrefetchCompleted,
  getLegacyApiKeyPrefetchResult,
  getMacOsKeychainStorageServiceName,
  getSecureStorage,
  getUsername,
  noteCredentialStoreReadError,
} from '../../../platform/secure-storage/index.js'
import { keychainReachable } from '../../../platform/secure-storage/macOsKeychainHelpers.js'
import { readKeychainServiceSync } from '../../../platform/secure-storage/macOsKeychainStorage.js'
import { getApiKeyHelperFromOutsideCheckoutSources, getSettingsForSource, getInitialSettings } from '../../../platform/settings/settings.js'
import { clearToolSchemaCache } from '../../roads/toolSchemaCache.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import { maybeRemoveApiKeyFromMacOSKeychainSyncThrows, normalizeApiKeyForConfig } from './authPortable.js'
import { isOAuthTokenExpired, shouldUseClaudeAIAuth } from '../oauth-shapes/scopes.js'
import type { OAuthTokens, SubscriptionType, RateLimitTier } from '../oauth-shapes/types.js'
import { binaryName } from '../../../platform/settings/config.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'


export function isAnthropicAuthEnabled(): boolean {
  if (isBareMode()) return false

  if (flagEnv('MERCURY_API_UNIX_SOCKET')) {
    return Boolean(flagEnv('MERCURY_OAUTH_TOKEN'))
  }

  if (hostEnv().ANTHROPIC_AUTH_TOKEN) return false
  if (getInitialSettings().credentials?.keyCommand || getInitialSettings().credentials?.keyCommands?.anthropic) return false
  if (flagEnv('MERCURY_API_KEY_FILE_DESCRIPTOR')) return false
  try {
    const { source } = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
    if (source === 'ANTHROPIC_API_KEY' || source === 'credentials.keyCommand') return false
  } catch (error) {
    passedOver(error)
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
  } catch (error) {
    passedOver(error)
    return false
  }
}

export type AuthTokenSource =
  | 'credentials.keyCommand'
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
    return getSettingsForSource('flagSettings')?.credentials?.keyCommand || getSettingsForSource('flagSettings')?.credentials?.keyCommands?.anthropic ? wrap('credentials.keyCommand') : wrap('none')
  }
  if (hostEnv().ANTHROPIC_AUTH_TOKEN) return wrap('ANTHROPIC_AUTH_TOKEN')
  if (flagEnv('MERCURY_OAUTH_TOKEN')) return wrap('MERCURY_OAUTH_TOKEN')
  if (getOAuthTokenFromFileDescriptor() !== null) {
    return wrap('MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR')
  }
  if (getConfiguredApiKeyHelper()) return wrap('credentials.keyCommand')
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

export type WireCredentialSource =
  | { kind: 'env'; name: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'MERCURY_OAUTH_TOKEN' | 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR' }
  | { kind: 'helper' }
  | { kind: 'managed' }
  | { kind: 'none' }

export function wireCredentialSource(named?: 'x-api-key' | 'authorization'): WireCredentialSource {
  const bearer = getAuthTokenSource().source
  if (named === 'x-api-key') {
    const keyed = keyCredentialSource(bearer)
    if (keyed !== null) return keyed
  }
  if (bearer === 'ANTHROPIC_AUTH_TOKEN' || bearer === 'MERCURY_OAUTH_TOKEN' || bearer === 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR') {
    return { kind: 'env', name: bearer }
  }
  if (bearer === 'claude.ai') return { kind: 'managed' }
  return keyCredentialSource(bearer) ?? { kind: 'none' }
}

function keyCredentialSource(bearer: string): WireCredentialSource | null {
  let key: ApiKeySource = 'none'
  try {
    key = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source
  } catch (error) {
    passedOver(error)
  }
  if (key === 'ANTHROPIC_API_KEY') return { kind: 'env', name: 'ANTHROPIC_API_KEY' }
  if (key === 'credentials.keyCommand' || bearer === 'credentials.keyCommand') return { kind: 'helper' }
  if (key === '/logins managed key') return { kind: 'managed' }
  return null
}


export type ApiKeySource = 'ANTHROPIC_API_KEY' | 'credentials.keyCommand' | '/logins managed key' | 'none'

function isCiOrTest(): boolean {
  return isEnvTruthy(hostEnv().CI) || process.env.NODE_ENV === 'test'
}

export function getAnthropicApiKeyWithSource(opts?: {
  skipRetrievingKeyFromApiKeyHelper?: boolean
}): { key: string | null; source: ApiKeySource } {
  const skipHelper = opts?.skipRetrievingKeyFromApiKeyHelper === true

  if (isBareMode()) {
    if (hostEnv().ANTHROPIC_API_KEY) {
      return { key: hostEnv().ANTHROPIC_API_KEY!, source: 'ANTHROPIC_API_KEY' }
    }
    if (getSettingsForSource('flagSettings')?.credentials?.keyCommand || getSettingsForSource('flagSettings')?.credentials?.keyCommands?.anthropic) {
      if (skipHelper) return { key: null, source: 'credentials.keyCommand' }
      return { key: getApiKeyFromApiKeyHelperCached(), source: 'credentials.keyCommand' }
    }
    return { key: null, source: 'none' }
  }

  if (preferThirdPartyAuthentication() && hostEnv().ANTHROPIC_API_KEY) {
    return { key: hostEnv().ANTHROPIC_API_KEY!, source: 'ANTHROPIC_API_KEY' }
  }

  if (isCiOrTest()) {
    const fromFd = getApiKeyFromFileDescriptor()
    if (fromFd !== null) return { key: fromFd, source: 'ANTHROPIC_API_KEY' }
    const keyVar = hostEnv().ANTHROPIC_API_KEY
    const hasTokenVar = Boolean(
      flagEnv('MERCURY_OAUTH_TOKEN') ||
        flagEnv('MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR') ||
        hostEnv().ANTHROPIC_AUTH_TOKEN,
    )
    if (!keyVar && !hasTokenVar) {
      throw new Error(
        'No credential found. Set ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or MERCURY_OAUTH_TOKEN to run in this environment.',
      )
    }
    if (keyVar) return { key: keyVar, source: 'ANTHROPIC_API_KEY' }
    return { key: null, source: 'none' }
  }

  if (hostEnv().ANTHROPIC_API_KEY && isCustomApiKeyApproved(hostEnv().ANTHROPIC_API_KEY!)) {
    return { key: hostEnv().ANTHROPIC_API_KEY!, source: 'ANTHROPIC_API_KEY' }
  }

  const fromFd = getApiKeyFromFileDescriptor()
  if (fromFd !== null) return { key: fromFd, source: 'ANTHROPIC_API_KEY' }

  if (getConfiguredApiKeyHelper()) {
    if (skipHelper) return { key: null, source: 'credentials.keyCommand' }
    return { key: getApiKeyFromApiKeyHelperCached(), source: 'credentials.keyCommand' }
  }

  const managed = getApiKeyFromConfigOrMacOSKeychain()
  if (managed) return { key: managed, source: '/logins managed key' }

  return { key: null, source: 'none' }
}

export function getAnthropicApiKey(): string | null {
  return getAnthropicApiKeyWithSource().key
}

export function getAnthropicApiKeyWorkspaceId(key: string): string | undefined {
  if (!isConfigReadingAllowed()) return undefined
  const workspace = getGlobalConfig().anthropicApiKeyWorkspace
  return workspace?.keyFingerprint === createHash('sha256').update(key).digest('hex')
    ? workspace.workspaceId : undefined
}

export function anthropicApiKeyHeaders(key: string): Record<string, string> {
  const workspaceId = getAnthropicApiKeyWorkspaceId(key)
  return { 'x-api-key': key, ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}) }
}

export function hasFirstPartyCredential(): boolean {
  try {
    return (
      getAuthTokenSource().hasToken ||
      getAnthropicApiKeyWithSource().source !== 'none' ||
      Boolean(hostEnv().ANTHROPIC_API_KEY)
    )
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function hasAnthropicApiKeyAuth(): boolean {
  try {
    return getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).key !== null
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function isCustomApiKeyApproved(key: string): boolean {
  const approved = getGlobalConfig().customApiKeyResponses?.approved ?? []
  return approved.includes(normalizeApiKeyForConfig(key))
}


export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    const flag = getSettingsForSource('flagSettings')?.credentials
    return flag?.keyCommand ?? flag?.keyCommands?.anthropic
  }
  if (untrustedWorkspaceHeadless()) return getApiKeyHelperFromOutsideCheckoutSources()
  const credentials = getInitialSettings().credentials
  return credentials?.keyCommand ?? credentials?.keyCommands?.anthropic
}

const DEFAULT_HELPER_TTL_MS = 5 * 60 * 1000
const HELPER_FAILURE_BACKOFF_MS = 30_000

function calculateApiKeyHelperTTL(): number {
  const raw = flagEnv('MERCURY_API_KEY_HELPER_TTL_MS')
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
    timeout: 10_000,
    preserveOutputOnError: true,
    cwd: getCwd(),
  })
  if (result.code !== 0) {
    const stderr = result.stderr.trim()
    const why = execOutcomeTimedOut(result.error) ? 'timed out' : `exited with code ${result.code}`
    throw new Error(`credentials.keyCommand ${why}${stderr ? `: ${stderr}` : ''}`)
  }
  const value = result.stdout.trim()
  if (value === '') throw new Error('credentials.keyCommand returned no value')
  return value
}

function helperBlockedByTrust(): boolean {
  const configured = getConfiguredApiKeyHelper()
  if (!configured) return false
  const proj = getSettingsForSource('projectSettings')?.credentials
  const local = getSettingsForSource('localSettings')?.credentials
  const fromProjectScope =
    configured === (proj?.keyCommand ?? proj?.keyCommands?.anthropic) ||
    configured === (local?.keyCommand ?? local?.keyCommands?.anthropic)
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
      `The credentials.keyCommand was invoked before workspace trust was confirmed and was not executed. ${binaryName()} — report issues via /feedback.`,
    )
    return null
  }

  const now = Date.now()
  const ttl = helperCache.value === HELPER_SENTINEL ? HELPER_FAILURE_BACKOFF_MS : calculateApiKeyHelperTTL()
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
        process.stderr.write(`\x1b[31mcredentials.keyCommand failed: ${errorMessage(error)}\x1b[0m\n`)
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


let managedKeyMemoStamp: number | null = null
let signedOutOAuthMemoStamp: number | null = null

export const getApiKeyFromConfigOrMacOSKeychain = memoize((): string | null => {
  const key = readManagedKey()
  managedKeyMemoStamp = getGlobalConfigCacheStamp()
  return key
})

function readManagedKey(): string | null {
  if (isBareMode()) return null
  if (keychainReachable()) {
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
  return readKeychainServiceSync(getMacOsKeychainStorageServiceName())
}

const API_KEY_FORMAT_RE = /^[A-Za-z0-9_-]+$/

export async function saveApiKey(key: string, options?: { workspaceId?: string }): Promise<void> {
  if (!API_KEY_FORMAT_RE.test(key)) {
    throw new Error('Invalid API key format: only letters, digits, dashes and underscores are allowed')
  }
  const workspaceId = options?.workspaceId?.trim() || undefined
  if (workspaceId && !API_KEY_FORMAT_RE.test(workspaceId)) throw new Error('Enter a valid Anthropic workspace ID')
  if (keychainReachable()) {
    try {
      const { maybeRemoveApiKeyFromMacOSKeychainThrows } = await import('./authPortable.js')
      await maybeRemoveApiKeyFromMacOSKeychainThrows()
    } catch (error) {
      logError(error)
    }
  }
  let keychainWritten = false
  if (keychainReachable()) {
    keychainWritten = writeKeychainHexStdin(key)
  }
  saveGlobalConfig(current => {
    const responses = current.customApiKeyResponses ?? { approved: [], rejected: [] }
    const normalized = normalizeApiKeyForConfig(key)
    const approved = responses.approved ?? []
    return {
      ...current,
      primaryApiKey: keychainWritten ? undefined : key,
      anthropicApiKeyWorkspace: workspaceId ? { keyFingerprint: createHash('sha256').update(key).digest('hex'), workspaceId } : undefined,
      customApiKeyResponses: {
        approved: approved.includes(normalized) ? approved : [...approved, normalized],
        rejected: responses.rejected ?? [],
      },
    }
  })
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
  if (getApiKeyFromConfigOrMacOSKeychain() !== key || !isCustomApiKeyApproved(key) || getAnthropicApiKeyWorkspaceId(key) !== workspaceId) {
    throw new Error('The Anthropic API key could not be saved. Try again.')
  }
}

function writeKeychainHexStdin(key: string): boolean {
  try {
    const hex = Buffer.from(key, 'utf-8').toString('hex')
    const commandLine = `add-generic-password -U -a "${getUsername()}" -s "${getMacOsKeychainStorageServiceName()}" -X ${hex}\n`
    const result = spawnSync('security', ['-i'], { windowsHide: true, input: commandLine, encoding: 'utf-8', timeout: 10_000, env: { ...subprocessEnv() } })
    return result.status === 0
  } catch (error) {
    passedOver(error)
    return false
  }
}

function clearStoredApiKeyConfig(): void {
  saveGlobalConfig(current => ({ ...current, primaryApiKey: undefined, anthropicApiKeyWorkspace: undefined }))
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
  noteCredentialChange()
}

export async function removeApiKey(): Promise<void> {
  if (keychainReachable()) {
    const { maybeRemoveApiKeyFromMacOSKeychainThrows } = await import('./authPortable.js')
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  }
  clearStoredApiKeyConfig()
}

export function removeApiKeySync(): void {
  if (keychainReachable()) {
    maybeRemoveApiKeyFromMacOSKeychainSyncThrows()
  }
  clearStoredApiKeyConfig()
}



type UnsavedRefresh = { tokens: OAuthTokens; supersedes: string; warning: string; at: number }
let unsavedRefresh: UnsavedRefresh | null = null

export function getOAuthRefreshSaveFailure(): { warning: string; at: number } | null {
  return unsavedRefresh === null ? null : { warning: unsavedRefresh.warning, at: unsavedRefresh.at }
}

export function __resetUnsavedRefreshForTest(): void {
  unsavedRefresh = null
}

export function clearUnsavedRefresh(): void {
  unsavedRefresh = null
}

function overlayUnsavedRefresh(stored: OAuthTokens | null): OAuthTokens | null {
  const held = unsavedRefresh
  if (held === null) return stored
  if (stored !== null && stored.refreshToken === held.supersedes) return held.tokens
  unsavedRefresh = null
  return stored
}

export function holdUnsavedRefresh(
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
    scopes: [INFERENCE_SCOPE],
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
  const envToken = flagEnv('MERCURY_OAUTH_TOKEN')
  if (envToken) {
    return synthesizedEnvToken(envToken)
  }
  const fromFd = getOAuthTokenFromFileDescriptor()
  if (fromFd !== null) return synthesizedEnvToken(fromFd)
  try {
    const stored = getSecureStorage().read()?.claudeAiOauth
    clearCredentialStoreReadError()
    return overlayUnsavedRefresh(stored?.accessToken ? stored : null)
  } catch (error) {
    noteCredentialStoreReadError(error)
    logError(error)
  }
  return null
}

export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  if (isBareMode()) return null
  const envToken = flagEnv('MERCURY_OAUTH_TOKEN')
  if (envToken) {
    return synthesizedEnvToken(envToken)
  }
  const fromFd = getOAuthTokenFromFileDescriptor()
  if (fromFd !== null) return synthesizedEnvToken(fromFd)
  try {
    const data = await getSecureStorage().readAsync()
    clearCredentialStoreReadError()
    const stored = data?.claudeAiOauth
    return overlayUnsavedRefresh(stored?.accessToken ? stored : null)
  } catch (error) {
    noteCredentialStoreReadError(error)
    logError(error)
  }
  return null
}

export function hasStoredOAuthToken(): boolean {
  try {
    const has = getSecureStorage().read()?.claudeAiOauth?.accessToken !== undefined
    clearCredentialStoreReadError()
    return has
  } catch (error) {
    noteCredentialStoreReadError(error)
    passedOver(error)
    return false
  }
}

export function clearOAuthTokenMemos(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
}

export function clearAuthCredentialMemos(): void {
  signedOutOAuthMemoStamp = null
  managedKeyMemoStamp = null
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
  clearBetasWhereKept()
  clearToolSchemaCache()
}

export function invalidateAuthMemoStamps(onSignedOutStale: () => void): void {
  const stamp = getGlobalConfigCacheStamp()
  if (managedKeyMemoStamp !== null && stamp !== managedKeyMemoStamp) {
    managedKeyMemoStamp = null
    getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
    clearLegacyApiKeyPrefetch()
  }
  if (signedOutOAuthMemoStamp !== null && stamp !== signedOutOAuthMemoStamp) {
    signedOutOAuthMemoStamp = null
    onSignedOutStale()
  }
}

const knownDeadRefreshTokens = new Set<string>()

export function isOAuthRefreshKnownDead(): boolean {
  const refresh = getClaudeAIOAuthTokens()?.refreshToken
  if (refresh === undefined || refresh === null) return false
  if (refresh === '') return true
  return knownDeadRefreshTokens.has(refresh)
}

export function markKnownDeadRefreshToken(refreshToken: string): void {
  knownDeadRefreshTokens.add(refreshToken)
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
  } catch (error) {
    passedOver(error)
    return false
  }
}


const OAUTH_REFRESH_LOCK_STALE_MS = 10_000

export function oauthRefreshLockSite(): { dir: string; options: { realpath: false; stale: number } } {
  return { dir: getAuthConfigHomeDir(), options: { realpath: false, stale: OAUTH_REFRESH_LOCK_STALE_MS } }
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
export function isCrewSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}
export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}
export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function isCrewPremiumSubscriber(): boolean {
  return getSubscriptionType() === 'team' && getRateLimitTier() === 'default_claude_max_5x'
}

export function getRateLimitTier(): RateLimitTier | null {
  if (!isAnthropicAuthEnabled()) return null
  const tokens = getClaudeAIOAuthTokens()
  return tokens?.rateLimitTier ?? null
}

export function hasProfileScope(): boolean {
  const tokens = getClaudeAIOAuthTokens()
  return tokens?.scopes.includes(PROFILE_SCOPE) ?? false
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

const scopedAccountIdentityCache = new Map<
  string,
  { mtimeMs: number; size: number; account: ReturnType<typeof getGlobalConfig>['oauthAccount'] | null }
>()

function readScopedOauthAccount(dir: string) {
  const file = scopeIdentityFile(dir)
  let stamp: { mtimeMs: number; size: number }
  try {
    const stat = statSync(file)
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    scopedAccountIdentityCache.delete(dir)
    return null
  }
  const cached = scopedAccountIdentityCache.get(dir)
  if (cached !== undefined && cached.mtimeMs === stamp.mtimeMs && cached.size === stamp.size) {
    return cached.account
  }
  let account: ReturnType<typeof getGlobalConfig>['oauthAccount'] | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const candidate = parsed?.oauthAccount
    if (
      candidate &&
      typeof candidate.accountUuid === 'string' &&
      candidate.accountUuid.trim() !== ''
    ) {
      account = candidate
    }
  } catch {
    account = null
  }
  scopedAccountIdentityCache.set(dir, { ...stamp, account })
  return account
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

export { ensureKeychainPrefetchCompleted }
