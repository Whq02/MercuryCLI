/**
 * The auth core: credential-source precedence, the API-key ladder, the
 * helper cache, OAuth read/refresh/401, subscription facts, cloud-provider
 * auth refresh, and organisation enforcement.
 *
 * Security invariants preserved: a project-scoped key helper is never
 * executed before workspace trust; the account-information summary sits on a
 * throwing path by design; the refresh path serialises on a per-scope lock;
 * an `invalid_grant` marks the token the attempt actually used dead.
 */
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
import { keychainReachable } from './secureStorage/macOsKeychainHelpers.js'
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

// ===========================================================================
// E1. Whether first-party auth is enabled
// ===========================================================================

export function isAnthropicAuthEnabled(): boolean {
  if (isBareMode()) return false

  // Unix-socket tunnel: the answer is exactly "an OAuth token env var is
  // present" — nothing else is consulted.
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return Boolean(process.env.MERCURY_OAUTH_TOKEN)
  }

  // Every external-token disabler (auth-token variable, merged-settings key
  // helper, API-key file descriptor) and the external-key-source disabler.
  if (process.env.ANTHROPIC_AUTH_TOKEN) return false
  if (getSettings_DEPRECATED().apiKeyHelper) return false
  if (process.env.MERCURY_API_KEY_FILE_DESCRIPTOR) return false
  try {
    const { source } = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
    if (source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper') return false
  } catch {
    // No key anywhere (CI/test) — treat as "no key".
  }
  return true
}

// ===========================================================================
// E2. Auth-token source
// ===========================================================================

// ── The Anthropic ACTIVE-slot preference ──────────────────────────────────
//  The family's two Mercury-held slots are the claude.ai sign-in and the
//  /logins managed key. Precedence is subscription-first; the stored
//  preference 'api-key' flips the SEAT — the wire bills the key, the
//  sign-in stays stored and background-refreshed (doRefresh reads scope
//  facts, never this preference). ONE door: the two active-source
//  predicates below consult subscriptionYieldsToManagedKey() and nothing
//  else does — never a parallel resolution path. The yield is guarded on
//  the key actually resolving, so a removed key hands the seat back to the
//  subscription instead of refusing credential-less.

export type AnthropicActiveSource = 'subscription' | 'api-key'

/** The stored preference, or undefined (subscription-first, the default). */
export function readAnthropicPreferredSource(): AnthropicActiveSource | undefined {
  return getGlobalConfig().anthropicPreferredSource
}

/** Write the preference (null clears it back to subscription-first). The
 *  slot-switch owner is the only production writer; it pairs this with the
 *  usage-truth reset (the account behind the session changed). */
export function writeAnthropicPreferredSource(kind: AnthropicActiveSource | null): void {
  saveGlobalConfig(current => {
    const next = { ...current }
    if (kind === null) delete next.anthropicPreferredSource
    else next.anthropicPreferredSource = kind
    return next
  })
}

/** TRUE exactly when the stored claude.ai sign-in yields the active seat to
 *  the managed key: preference 'api-key' AND the key resolving right now. */
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
    // The slot preference: the sign-in yields the seat to the managed key
    // (the key ladder answers the client when no token source does).
    !subscriptionYieldsToManagedKey()
  ) {
    return wrap('claude.ai')
  }
  return wrap('none')
}

/** A login-time warning naming a shadowing environment token, or nothing
 *  (the predicate itself is owned by `utils/loginShadow.ts`). */
export function loginShadowWarning(): string | null {
  return loginShadowWarningFor(getAuthTokenSource().source)
}

// ===========================================================================
// E3. API-key resolution ladder
// ===========================================================================

export type ApiKeySource = 'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/logins managed key' | 'none'

function isCiOrTest(): boolean {
  return isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test'
}

export function getAnthropicApiKeyWithSource(opts?: {
  skipRetrievingKeyFromApiKeyHelper?: boolean
}): { key: string | null; source: ApiKeySource } {
  const skipHelper = opts?.skipRetrievingKeyFromApiKeyHelper === true

  // 1. Bare mode: only the env var, then a flag-sourced helper (a skipped
  //    helper still reports the helper source, with no key).
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

  // 2. Print mode preferring third-party auth + env var set.
  if (preferThirdPartyAuthentication() && process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  }

  // 3. CI / test (truthiness tests: an empty-string variable counts as
  //    absent, and an empty-string key is never returned).
  if (isCiOrTest()) {
    const fromFd = getApiKeyFromFileDescriptor()
    if (fromFd !== null) return { key: fromFd, source: 'ANTHROPIC_API_KEY' }
    const keyVar = process.env.ANTHROPIC_API_KEY
    // ANTHROPIC_AUTH_TOKEN counts: the transport accepts it as the bearer
    // (client.ts), so the presence check must agree — checker and transport
    // share one credential vocabulary.
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

  // 4. The env var, only if its normalized form is approved.
  if (process.env.ANTHROPIC_API_KEY && isCustomApiKeyApproved(process.env.ANTHROPIC_API_KEY)) {
    return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
  }

  // 5. The key file descriptor (reported under the env-var source).
  const fromFd = getApiKeyFromFileDescriptor()
  if (fromFd !== null) return { key: fromFd, source: 'ANTHROPIC_API_KEY' }

  // 6. A configured key helper — the helper ALWAYS wins (a cold cache does
  //    NOT fall through to the keychain).
  if (getConfiguredApiKeyHelper()) {
    if (skipHelper) return { key: null, source: 'apiKeyHelper' }
    return { key: getApiKeyFromApiKeyHelperCached(), source: 'apiKeyHelper' }
  }

  // 7. The login-managed key.
  const managed = getApiKeyFromConfigOrMacOSKeychain()
  if (managed) return { key: managed, source: '/logins managed key' }

  return { key: null, source: 'none' }
}

export function getAnthropicApiKey(): string | null {
  return getAnthropicApiKeyWithSource().key
}

/**
 * Whether ANY first-party credential is present — an OAuth token from any
 * source, a resolved API key, or the raw ANTHROPIC_API_KEY variable (the
 * same three legs `auth status` calls logged in). Never throws: a resolver
 * that cannot answer reads as no credential.
 */
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

/** Never throws (swallows the CI/test throw). */
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

// ===========================================================================
// E4. Key-helper execution and cache
// ===========================================================================

export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) return getSettingsForSource('flagSettings')?.apiKeyHelper
  // Untrusted workspace, headless road (FC-144): the helper is an arbitrary
  // command run to mint credentials — a checkout-delivered one must not
  // execute in a directory the operator never trusted. Outside-checkout
  // sources (config home / flag / policy) still apply.
  if (untrustedWorkspaceHeadless()) return getApiKeyHelperFromOutsideCheckoutSources()
  return getSettings_DEPRECATED().apiKeyHelper
}

const DEFAULT_HELPER_TTL_MS = 5 * 60 * 1000

/** An absent or empty variable falls back silently; only a present-but-
 *  invalid value logs. Integer parse — a fractional string is truncated. */
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

/** The single-space sentinel occupying the slot so the ladder stops. It is
 *  INTERNAL to the cache: a public reader answers null for it, never a
 *  one-space key (FN-015 rank 48 — the sentinel used to ride a probe request
 *  as the credential, paint "invalid API key", and become an empty bearer on
 *  the turn path). */
const HELPER_SENTINEL = ' '

type HelperCache = {
  value: string | null
  fetchedAt: number
  epoch: number
  inFlight: { promise: Promise<string | null>; isBackground: boolean; startedAt: number } | null
  /** The last execution's failure, kept until an execution succeeds — it
   *  survives the cache clear the 401 lap performs, so the presenter can
   *  still name it. */
  failure: { message: string; at: number } | null
}

const helperCache: HelperCache = { value: null, fetchedAt: 0, epoch: 0, inFlight: null, failure: null }

/** The public shape of a cached slot: the sentinel is a failed helper. */
function publicHelperValue(value: string | null): string | null {
  return value === HELPER_SENTINEL ? null : value
}

export function getApiKeyFromApiKeyHelperCached(): string | null {
  return publicHelperValue(helperCache.value)
}

/** Why the configured helper produced no key, or null when its last
 *  execution succeeded (or none ran yet). */
export function getApiKeyHelperFailure(): { message: string; at: number } | null {
  return helperCache.failure
}

/** A configured helper whose last execution failed: the request would carry
 *  no credential, so a 401 is the helper's failure in costume. */
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

/** The exec helper's failure string names a timeout when the command was
 *  killed by its time budget. */
function execOutcomeTimedOut(error: string | undefined): boolean {
  return error !== undefined && /timed out/i.test(error)
}

async function executeApiKeyHelper(helper: string): Promise<string> {
  // Portable shell invocation: the exec helper's shell mode resolves to the
  // platform shell (never a hard-coded /bin/sh). Resolves on non-zero exit
  // so stderr can be surfaced.
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

/** True when the CONFIGURED helper value is the project- or local-scope
 *  value (a value comparison, not mere presence of any project/local helper)
 *  and trust is not yet accepted in an interactive session. */
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

  // Stale-while-revalidate: a stale entry returns the stale value and kicks a
  // single background refresh (a stale sentinel re-runs the helper the same
  // way and answers null meanwhile).
  if (helperCache.value !== null) {
    if (helperCache.inFlight === null) {
      startHelperExecution(helper, true)
    }
    return publicHelperValue(helperCache.value)
  }

  // Cold cache: deduplicate onto one in-flight promise.
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
        // Only a non-null result is written.
        helperCache.value = value
        helperCache.fetchedAt = Date.now()
      }
      helperCache.failure = null
      return value
    } catch (error) {
      // The failure is recorded for the readers and the presenter; the raw
      // stderr line stays on the headless road only — in the cockpit it
      // landed in the middle of a live repaint, and the typed message is
      // what the operator sees there.
      if (getIsNonInteractiveSession()) {
        process.stderr.write(`\x1b[31mapiKeyHelper failed: ${errorMessage(error)}\x1b[0m\n`)
      }
      logError(error)
      helperCache.failure = { message: errorMessage(error), at: Date.now() }
      if (helperCache.epoch === epoch) {
        if (helperCache.value !== null && helperCache.value !== HELPER_SENTINEL) {
          // Stale-refresh transient failure: keep the last good value, bump ts.
          helperCache.fetchedAt = Date.now()
        } else {
          // Cold / prior-error: cache the sentinel.
          helperCache.value = HELPER_SENTINEL
          helperCache.fetchedAt = Date.now()
        }
      }
      // A failed helper is a null key to every caller; the sentinel only
      // holds the slot so the ladder stops.
      return helperCache.epoch === epoch ? publicHelperValue(helperCache.value) : null
    } finally {
      if (helperCache.epoch === epoch) helperCache.inFlight = null
    }
  })()
  helperCache.inFlight = { promise, isBackground, startedAt: Date.now() }
}

/** Start the helper early; skip when project-scoped and trust not accepted. */
export function prefetchApiKeyFromApiKeyHelperIfSafe(isNonInteractiveSession: boolean): void {
  if (!getConfiguredApiKeyHelper()) return
  if (helperBlockedByTrust()) return
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

// ===========================================================================
// E5. Stored login-managed key
// ===========================================================================

/** The config-estate stamps under which each credential memo last answered
 *  NULL (a found credential is not provisional; the same-process writers
 *  clear it). A sign-in touches the global config on every platform — the
 *  managed key itself off the keychain, the approval row beside a keychain
 *  write, the account row beside a claude.ai token — and the config cache's
 *  freshness watcher advances the stamp when another process's write lands,
 *  so a signed-out runner re-reads on its next request instead of holding
 *  boot's null for the chat's whole life (the reader: invalidateOnDiskChange). */
let signedOutKeyMemoStamp: number | null = null
let signedOutOAuthMemoStamp: number | null = null

export const getApiKeyFromConfigOrMacOSKeychain = memoize((): string | null => {
  const key = readManagedKey()
  // A null answer is PROVISIONAL: it stands until the credential estate
  // moves (invalidateOnDiskChange). A found key is not — the same-process
  // writers (saveApiKey / removeApiKey) clear it themselves.
  signedOutKeyMemoStamp = key === null ? getGlobalConfigCacheStamp() : null
  return key
})

function readManagedKey(): string | null {
  if (isBareMode()) return null
  // The one rule (keychainReachable): off darwin, or with the credential
  // store pinned to the file backend, the managed key lives in the config
  // estate alone and the keychain tool is never spawned.
  if (keychainReachable()) {
    const prefetch = getLegacyApiKeyPrefetchResult()
    if (prefetch !== null) {
      // A completed prefetch with no key falls through to config, NOT to a
      // second keychain read.
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

/** A synchronous keychain lookup (account = current user, service = the
 *  product's keychain service name). Throws on a failed lookup — the caller
 *  logs and falls through to config. */
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
  // Remove any existing keychain entry (swallow + log its failure).
  if (keychainReachable()) {
    try {
      const { maybeRemoveApiKeyFromMacOSKeychainThrows } = await import('./authPortable.js')
      await maybeRemoveApiKeyFromMacOSKeychainThrows()
    } catch (error) {
      logError(error)
    }
  }
  // Under the file pin the write is never attempted, so the key lands in
  // the config estate below — a scratch-home proof saving a fixture key
  // leaves no entry in the machine's keychain.
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
      // Store the raw key in config ONLY when the keychain write did not
      // succeed.
      ...(keychainWritten ? {} : { primaryApiKey: key }),
      customApiKeyResponses: {
        approved: approved.includes(normalized) ? approved : [...approved, normalized],
        rejected: responses.rejected ?? [],
      },
    }
  })
  // Clear the memo AND the boot prefetch: a completed prefetch otherwise
  // keeps answering the memoized reader and the just-saved key stays
  // invisible for the rest of the process.
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
  clearLegacyApiKeyPrefetch()
}

/** Write via the keychain tool's INTERACTIVE STDIN mode: the tool is spawned
 *  with only the interactive flag and the whole add-command — including the
 *  hex-encoded value (the tool's hex-DATA form) — rides stdin, so the secret
 *  never appears in process arguments. Success = the invocation did not
 *  throw (the tool's exit status is not consulted). */
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
  if (keychainReachable()) {
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

// ===========================================================================
// E6. OAuth tokens
// ===========================================================================

// --- A refresh that landed on the wire but not on disk (FN-015 rank 47) ----

/** A refreshed pair the token endpoint issued and the credential store
 *  refused to write. The wire has already spent the previous refresh token,
 *  so discarding the pair would send the stale access token, draw a 401,
 *  and burn the spent refresh token into invalid_grant and the sign-in
 *  wall. The pair is held here for THIS process — every token reader
 *  answers it over the disk record it supersedes — until a later save
 *  lands or the stored record moves under it (another process saved, a new
 *  sign-in, a sign-out). `supersedes` is the refresh token the DISK holds. */
type UnsavedRefresh = { tokens: OAuthTokens; supersedes: string; warning: string; at: number }
let unsavedRefresh: UnsavedRefresh | null = null

/** The storage failure of the last refresh, while its pair is still held
 *  unsaved; null once a save lands or the store moves. */
export function getOAuthRefreshSaveFailure(): { warning: string; at: number } | null {
  return unsavedRefresh === null ? null : { warning: unsavedRefresh.warning, at: unsavedRefresh.at }
}

export function __resetUnsavedRefreshForTest(): void {
  unsavedRefresh = null
}

function overlayUnsavedRefresh(stored: OAuthTokens | null): OAuthTokens | null {
  const held = unsavedRefresh
  if (held === null) return stored
  // The disk still holds the record the pair superseded: the pair answers.
  if (stored !== null && stored.refreshToken === held.supersedes) return held.tokens
  // The store moved under the pair: the disk is the truth again.
  unsavedRefresh = null
  return stored
}

function holdUnsavedRefresh(
  tokens: OAuthTokens,
  superseded: OAuthTokens,
  verdict: { warning?: string; code?: string },
): void {
  // A pair refreshed from a held pair still supersedes the DISK's record.
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
  // The same provisional-null law as the managed key: a signed-out answer
  // stands only until the credential estate moves.
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

/** Never throws — is a token stored in keychain/credentials-file (as opposed
 *  to environment-only)? */
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

/**
 * Drop every credential memo this process holds so the next read is the
 * DISK's truth: the claude.ai token memo (and the keychain cache under
 * it), the login-managed key memo and the boot prefetch that feeds it, and
 * the per-credential derived caches (the beta-header set, the tool-schema
 * shape). Sync, no network — the warm session runner calls it at the
 * moment it is claimed: the runner booted BEFORE the operator's sign-in
 * and memoised "no credential"; the disk-change invalidator only runs on
 * the token-refresh road, so the first turn otherwise refused with the
 * boot-time null and a stale header set.
 */
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
        // Fall back to the previously-stored values when the incoming ones
        // are null (a transient profile lookup must not downgrade to
        // "unknown").
        subscriptionType: tokens.subscriptionType ?? previous?.subscriptionType ?? null,
        rateLimitTier: tokens.rateLimitTier ?? previous?.rateLimitTier ?? null,
      },
    })
    // After a write: the token memo, the beta caches and the tool-schema
    // cache are all cleared.
    clearOAuthTokenCache()
    clearBetasCaches()
    clearToolSchemaCache()
    // A landed save is the truth again; a pair held unsaved is released.
    if (result.success) unsavedRefresh = null
    return result
  } catch (error) {
    logError(error)
    return { success: false, warning: 'Failed to save credentials to secure storage' }
  }
}

// --- Known-dead refresh tokens ---------------------------------------------

const knownDeadRefreshTokens = new Set<string>()

/** TRUE only when the current refresh token is the empty string (previously
 *  blanked) or is in the recorded-dead set; a wholly absent token or refresh
 *  token answers FALSE. */
export function isOAuthRefreshKnownDead(): boolean {
  const refresh = getClaudeAIOAuthTokens()?.refreshToken
  if (refresh === undefined || refresh === null) return false
  if (refresh === '') return true
  return knownDeadRefreshTokens.has(refresh)
}

export function __resetKnownDeadRefreshTokensForTest(): void {
  knownDeadRefreshTokens.clear()
}

/**
 * TRUE only on claude.ai sign-in states the estate has ALREADY observed —
 * never a network probe: the stored refresh token is dead (blanked after
 * invalid_grant / recorded dead this process), or the access token is past
 * its expiry with no refresh token to spend. The one predicate behind the
 * fail-fast 401 (withRetry), the attributed "sign-in expired" presenter
 * line, and the /model row's honest state.
 */
export function isAnthropicOAuthSignInExpired(): boolean {
  try {
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens) return false
    // Only when the stored claude.ai sign-in IS the wire's credential: an
    // env bearer shadowing it owns its own 401 (the login-shadow branch of
    // the presenter speaks that case).
    if (getAuthTokenSource().source !== 'claude.ai') return false
    if (isOAuthRefreshKnownDead()) return true
    return isOAuthTokenExpired(tokens.expiresAt) && !tokens.refreshToken
  } catch {
    return false
  }
}

// --- Cross-process staleness ------------------------------------------------

function credentialsFilePath(): string {
  return join(getAuthConfigHomeDir(), '.credentials.json')
}

/** The credential file's mtime at the last check; null = the file was ABSENT
 *  (or never looked at), so a stat that succeeds after a null IS a change. */
let lastCredentialsMtimeMs: number | null = null

/**
 * The cross-process invalidator, run at the top of every request's auth
 * step. FN-019 blocker 1: a runner spawned before the first sign-in ("sign
 * in later" on the onboarding, or an install without network) memoized
 * null here; the credential file then appeared with an mtime this process
 * had never seen, and the old `!== null` guard read that as nothing to
 * clear — every message of the chat answered "Authentication failed" after
 * a sign-in that changed nothing, for the runner's whole life (idle
 * retirement never ends a chat with a conversation). Absent-to-present is
 * a change; and the managed key, whose memo had no disk invalidator at all,
 * rides the config estate's own freshness stamp.
 */
function invalidateOnDiskChange(): void {
  try {
    const mtime = statSync(credentialsFilePath()).mtimeMs
    if (lastCredentialsMtimeMs === null || mtime !== lastCredentialsMtimeMs) {
      clearOAuthTokenCache()
    }
    lastCredentialsMtimeMs = mtime
  } catch {
    // Missing file (keychain path): clear only the memo — and remember the
    // absence, so the file's arrival reads as the change it is.
    getClaudeAIOAuthTokens.cache?.clear?.()
    lastCredentialsMtimeMs = null
  }
  const stamp = getGlobalConfigCacheStamp()
  if (signedOutKeyMemoStamp !== null && stamp !== signedOutKeyMemoStamp) {
    // The config estate moved since this process last read no managed key:
    // the null answer, and the boot prefetch it may have come from, are
    // both stale (a completed prefetch would otherwise answer the cleared
    // memo with the same nothing).
    signedOutKeyMemoStamp = null
    getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
    clearLegacyApiKeyPrefetch()
  }
  if (signedOutOAuthMemoStamp !== null && stamp !== signedOutOAuthMemoStamp) {
    // The keychain path's arm of the same transition: the file never
    // appears there, but the login's account row moves the config, and the
    // keychain cache's TTL is the only thing the memo clear above cannot
    // reach.
    signedOutOAuthMemoStamp = null
    clearOAuthTokenCache()
  }
}

// --- Refresh ----------------------------------------------------------------

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
  // Another process already refreshed: nothing to do here (false).
  if (!force && !isOAuthTokenExpired(tokens.expiresAt)) return false
  if (isOAuthRefreshKnownDead()) return false

  // The inter-process lock lives on the auth-scope directory (created if
  // needed), so two processes refreshing the SAME switched account serialize
  // on the same lock.
  const lockDir = getAuthConfigHomeDir()
  let release: () => Promise<void>
  try {
    mkdirSync(lockDir, { recursive: true })
    release = await lock(lockDir, { realpath: false })
  } catch (error) {
    if ((error as { code?: string }).code === 'ELOCKED') {
      // Contention: retry (up to the budget) after a randomized 1000–2000 ms
      // wait; each retry re-runs the whole pre-lock sequence.
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
    // Refreshed by whoever held the lock before us: nothing to do (false).
    if (!force && !isOAuthTokenExpired(underLock.expiresAt)) return false
    if (isOAuthRefreshKnownDead()) return false

    const usedRefreshToken = underLock.refreshToken
    try {
      const refreshed = await refreshOAuthToken(
        usedRefreshToken,
        // Omit the scope list for subscription tokens so the default set
        // applies (scope expansion without re-login).
        shouldUseClaudeAIAuth(underLock.scopes) ? {} : { scopes: underLock.scopes },
      )
      // The save verdict is consumed (FN-015 rank 47): a pair the store
      // refused is held for this process rather than discarded — the wire
      // has already spent the refresh token that was presented.
      const saved = saveOAuthTokensIfNeeded(refreshed)
      if (!saved.success) holdUnsavedRefresh(refreshed, underLock, saved)
      clearOAuthTokenCache()
      return true
    } catch (error) {
      logError(error)
      clearOAuthTokenCache()
      const nowStored = await getClaudeAIOAuthTokensAsync()
      // The one true-for-someone-else-won arm: the error-path re-read finds
      // an unexpired token.
      if (nowStored && !isOAuthTokenExpired(nowStored.expiresAt)) return true
      if (isInvalidGrantError(error)) {
        knownDeadRefreshTokens.add(usedRefreshToken)
        // Awaited before the lock is released.
        await blankRefreshTokenOnDisk(usedRefreshToken)
      }
      return false
    }
  } finally {
    await release().catch(() => {})
  }
}

/** Best-effort blank of the on-disk refresh token, only if it is still the
 *  same one (a concurrent login must not be clobbered). Never throws. */
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

// --- 401 handling -----------------------------------------------------------

const in401 = new Map<string, Promise<boolean>>()

export async function handleOAuth401Error(failedAccessToken: string): Promise<boolean> {
  const existing = in401.get(failedAccessToken)
  if (existing !== undefined) return existing
  const run = (async (): Promise<boolean> => {
    clearOAuthTokenCache()
    const tokens = await getClaudeAIOAuthTokensAsync()
    if (!tokens?.refreshToken) return false
    // If storage now holds a different access token, another session already
    // refreshed.
    if (tokens.accessToken !== failedAccessToken) return true
    return checkAndRefreshOAuthTokenIfNeeded(0, true)
  })().finally(() => {
    in401.delete(failedAccessToken)
  })
  in401.set(failedAccessToken, run)
  return run
}

// ===========================================================================
// E7. Subscription and account facts
// ===========================================================================

/** No mock override exists in this build (the mock service's should-use
 *  predicate is gate-folded dead). */
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
    // The slot preference: with the managed key seated, the session IS a
    // key-billed Anthropic session — every subscriber-gated surface (the
    // limits latch, the upsells, the client's bearer pick) reads that one
    // truth here.
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

/** Has access to the top model tier — true for max/enterprise/team/pro AND
 *  null (API users and unpopulated types). */
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

// WIRE SPELLINGS: billingType values as the oauth account payload spells
// them — plumbing matched byte-identically, never shown to the operator.
const OVERAGE_BILLING_TYPES = new Set([
  'stripe_subscription',
  'stripe_subscription_contracted',
  'apple_subscription',
  'google_play_subscription',
])

export function isOverageProvisioningAllowed(): boolean {
  if (!isClaudeAISubscriber()) return false
  // The switched-scope-aware identity read, not the global config directly.
  const billing = getOauthAccountInfo()?.billingType
  return billing !== undefined && billing !== null && OVERAGE_BILLING_TYPES.has(billing)
}

/** Per-directory cache of the switched-scope identity read, keyed on the
 *  snapshot file's own identity (mtime + size): a heal, a sign-out or a
 *  re-login that rewrites `<dir>/.claude.json` is a new key, so a later
 *  bracket can never be served the departed account. */
const scopedAccountIdentityCache = new Map<
  string,
  { mtimeMs: number; size: number; account: ReturnType<typeof getGlobalConfig>['oauthAccount'] | null }
>()

/**
 * Inside an auth-scope bracket (the board's scoped reauth/read) the identity
 * comes from the BRACKETED scope directory's config file, so every identity
 * surface names the account whose store is being read. Compat-boundary read
 * of `.claude.json` (basename-census classified); requires a non-blank
 * account UUID to count as a hit; tolerates missing/unparseable files.
 */
function readScopedOauthAccount(dir: string) {
  const file = join(dir, '.claude.json')
  let stamp: { mtimeMs: number; size: number }
  try {
    const stat = statSync(file)
    stamp = { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    // No snapshot file: nothing to serve and nothing to remember — a file
    // that appears later is read on its first bracket.
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
  // A live auth-scope bracket is detected through the accessor
  // (undefined = at rest), not a directory-equality heuristic.
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

/** DOES NOT guard the throwing key resolver by design. Do not call from
 *  a probe. */
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
  // Resolves the key WITHOUT the skip flag and without a guard — inherits the
  // CI/test throw. The source is reported only when a KEY exists (a cold
  // helper cache contributes nothing).
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) info.apiKeySource = apiKeySource
  if (tokenSource === 'claude.ai' || apiKeySource === '/logins managed key') {
    const account = getGlobalConfig().oauthAccount
    if (account?.organizationName) info.organization = account.organizationName
    if (account?.emailAddress) info.email = account.emailAddress
  }
  return info
}

// ===========================================================================
// E8. Organisation enforcement
// ===========================================================================

export type OrgValidationResult = { valid: true } | { valid: false; message: string }

export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  if (process.env.ANTHROPIC_UNIX_SOCKET) return { valid: true }
  if (!isAnthropicAuthEnabled()) return { valid: true }
  const requiredOrg = getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrg) return { valid: true }

  await checkAndRefreshOAuthTokenIfNeeded()
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) return { valid: true }

  // ALWAYS fetch the authoritative org from the profile (a cached UUID is
  // user-writable and must not be trusted).
  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  const actualOrg = profile?.organization?.uuid
  const cli = binaryName()
  if (!actualOrg) {
    // Fails closed.
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

// (E9, the cloud-provider credential refresh — awsAuthRefresh /
// awsCredentialExport / gcpAuthRefresh executors, STS/GCP probes, and the
// credential prefetches — retired with the gateway estate,. Old
// settings files may still carry those keys; the settings schema's root
// passthrough tolerates them and nothing executes them.)

// ===========================================================================
// Re-exports
// ===========================================================================

export { storeAccount as storeOAuthAccountInfo }
export { ensureKeychainPrefetchCompleted }
