/**
 * Enterprise remote-policy settings: fetch from the vendor control plane,
 * ETag-validate, persist, hot-reload, poll. FAIL-OPEN throughout — a
 * control-plane outage never blocks a session.
 */
import { createHash } from 'node:crypto'
import { backgroundHttpsAgent } from '../../utils/proxy.js'
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs'

import axios from 'axios'

import { OAUTH_BETA_HEADER, getOauthConfig } from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { classifyAxiosError, isENOENT } from '../../utils/errors.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'
import { getRetryDelay } from '../api/withRetry.js'
import { checkManagedSettingsSecurity, handleSecurityCheckResult } from './securityCheck.js'
import { isRemoteManagedSettingsEligible, resetSyncCache } from './syncCache.js'
import {
  getRemoteManagedSettingsSyncFromCache,
  getSettingsPath,
  setSessionCache,
} from './syncCacheState.js'
import {
  RemoteManagedSettingsResponseSchema,
  type RemoteManagedSettingsFetchResult,
} from './types.js'

const FETCH_TIMEOUT_MS = 10_000
const MAX_RETRIES = 5
const LOADING_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 60 * 60 * 1000

export { isRemoteManagedSettingsEligible, resetSyncCache }

/** The public eligibility read. */
export function isEligibleForRemoteManagedSettings(): boolean {
  return isRemoteManagedSettingsEligible()
}

// ---------------------------------------------------------------------------
// Checksum (server-compatible — must match the Python side byte-for-byte)
// ---------------------------------------------------------------------------

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Recursively key-sorted, separator-compact JSON, SHA-256 hex, `sha256:`
 * prefixed. Exported so a test can pin server compatibility.
 */
export function computeChecksumFromSettings(settings: SettingsJson): string {
  const canonical = JSON.stringify(sortKeysDeep(settings))
  return `sha256:${createHash('sha256').update(canonical, 'utf-8').digest('hex')}`
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Local auth-header selection — NEVER the shared auth-headers entry point,
 * which would re-enter the settings reader. Key probe skips helper execution
 * and swallows its throw for the same reason eligibility does.
 */
function buildAuthHeaders(): Record<string, string> | null {
  try {
    const { key } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (key) return { 'x-api-key': key }
  } catch {
    // No key — fall through to OAuth.
  }
  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    return {
      Authorization: `Bearer ${tokens.accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
    }
  }
  return null
}

async function fetchRemoteSettings(
  cachedChecksum: string | null,
): Promise<RemoteManagedSettingsFetchResult> {
  // A stale cached token must not produce a spurious 401.
  await checkAndRefreshOAuthTokenIfNeeded()

  const authHeaders = buildAuthHeaders()
  if (authHeaders === null) {
    return { success: false, error: 'no authentication available', skipRetry: true }
  }
  const headers: Record<string, string> = {
    ...authHeaders,
    'User-Agent': getAnthropicClientUserAgent(),
  }
  if (cachedChecksum !== null) {
    headers['If-None-Match'] = `"${cachedChecksum}"`
  }

  try {
    const response = await axios.get(
      `${getOauthConfig().BASE_API_URL}/api/claude_code/settings`,
      {
        headers,
        timeout: FETCH_TIMEOUT_MS,
        // A background probe never holds the exit (the unref'd agent).
        httpsAgent: backgroundHttpsAgent(),
        validateStatus: status =>
          status === 200 || status === 204 || status === 304 || status === 404,
      },
    )
    if (response.status === 304) {
      // Cache still valid: settings explicitly null, checksum echoed back.
      return { success: true, settings: null, ...(cachedChecksum ? { checksum: cachedChecksum } : {}) }
    }
    if (response.status === 204 || response.status === 404) {
      // "This account has no managed settings" — an EMPTY object, which must
      // erase stale local policy rather than fall back to it. No checksum.
      return { success: true, settings: {} as SettingsJson }
    }
    const envelope = RemoteManagedSettingsResponseSchema().safeParse(response.data)
    if (!envelope.success) {
      return { success: false, error: 'remote settings response has an invalid format' }
    }
    const validated = SettingsSchema().safeParse(envelope.data.settings)
    if (!validated.success) {
      return { success: false, error: 'remote settings document has an invalid structure' }
    }
    return {
      success: true,
      settings: validated.data as SettingsJson,
      checksum: envelope.data.checksum,
    }
  } catch (error) {
    const classified = classifyAxiosError(error)
    // Status is inspected BEFORE kind: a raised 404 still means "no managed
    // settings", with an empty-string checksum (distinct from the status
    // path's absent one; neither is stored).
    if (classified.status === 404) {
      return { success: true, settings: {} as SettingsJson, checksum: '' }
    }
    if (classified.kind === 'auth') {
      return { success: false, error: 'authentication failed', skipRetry: true }
    }
    if (classified.kind === 'timeout') {
      return { success: false, error: 'remote settings request timed out' }
    }
    if (classified.kind === 'network') {
      return { success: false, error: 'network failure fetching remote settings' }
    }
    return { success: false, error: classified.message }
  }
}

/** Up to 5 retries (6 attempts); the same conditional checksum every retry. */
async function fetchWithRetry(
  cachedChecksum: string | null,
): Promise<RemoteManagedSettingsFetchResult> {
  let result = await fetchRemoteSettings(cachedChecksum)
  for (
    let attempt = 1;
    attempt <= MAX_RETRIES && !result.success && result.skipRetry !== true;
    attempt++
  ) {
    const delay = getRetryDelay(attempt)
    logForDebugging(`remote settings: retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay)}ms`)
    await new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, delay)
      timer.unref?.()
    })
    result = await fetchRemoteSettings(cachedChecksum)
  }
  return result
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

/** Owner-only, pretty-printed, data-synced before close. */
function writeSettingsFile(settings: SettingsJson): void {
  const fd = openSync(getSettingsPath(), 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(settings, null, 2))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function deleteSettingsFile(): void {
  try {
    unlinkSync(getSettingsPath())
  } catch (error) {
    if (!isENOENT(error)) {
      logForDebugging(`remote settings: cache file delete failed: ${String(error)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fetch-and-load (the decision matrix)
// ---------------------------------------------------------------------------

async function fetchAndLoadRemoteSettings(): Promise<SettingsJson | null> {
  if (!isRemoteManagedSettingsEligible()) return null
  // Read once at the top: the same value feeds the conditional checksum and
  // the approval gate's "what changed" comparison.
  const cached = getRemoteManagedSettingsSyncFromCache()
  const cachedChecksum = cached !== null ? computeChecksumFromSettings(cached) : null
  try {
    const result = await fetchWithRetry(cachedChecksum)
    if (!result.success) {
      if (cached !== null) {
        setSessionCache(cached)
        return cached
      }
      return null
    }
    // A 304's null settings coerce to the cached document (or fall through
    // to the empty row when no cache exists).
    const incoming = result.settings ?? cached ?? ({} as SettingsJson)
    if (result.settings === null && cached !== null) {
      setSessionCache(cached)
      return cached
    }
    if (Object.keys(incoming).length === 0) {
      setSessionCache(incoming)
      deleteSettingsFile()
      return incoming
    }
    const verdict = await checkManagedSettingsSecurity(cached, incoming)
    if (!handleSecurityCheckResult(verdict)) {
      // Rejected (and shutdown did not pre-empt): keep the cached settings.
      return cached
    }
    setSessionCache(incoming)
    try {
      writeSettingsFile(incoming)
    } catch (error) {
      logForDebugging(`remote settings: disk write failed: ${String(error)}`)
    }
    return incoming
  } catch (error) {
    if (cached !== null) {
      setSessionCache(cached)
      return cached
    }
    logForDebugging(`remote settings: load failed: ${String(error)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let loadingPromise: Promise<void> | null = null
let resolveLoading: (() => void) | null = null
let pollTimer: NodeJS.Timeout | null = null

/**
 * Create the wait-for-load promise early — only when eligible, only once —
 * with a 30 s self-resolving timeout so contexts that never call the loader
 * cannot deadlock on it.
 */
export function initializeRemoteManagedSettingsLoadingPromise(): void {
  if (!isRemoteManagedSettingsEligible()) return
  if (loadingPromise !== null) return
  loadingPromise = new Promise<void>(resolvePromise => {
    resolveLoading = resolvePromise
    const timer = setTimeout(() => {
      logForDebugging('remote settings: loading promise self-resolved after 30s')
      resolvePromise()
    }, LOADING_TIMEOUT_MS)
    timer.unref?.()
  })
}

/** Resolves immediately when no promise exists. */
export async function waitForRemoteManagedSettingsToLoad(): Promise<void> {
  if (loadingPromise === null) return
  await loadingPromise
}

/**
 * The startup load. Cache-first: a disk-cached document is adopted and the
 * promise resolved IMMEDIATELY (print-mode startup does not pay the fetch
 * latency); the fetch still runs. Never rejects.
 */
export async function loadRemoteManagedSettings(): Promise<void> {
  const eligible = isRemoteManagedSettingsEligible()
  if (eligible && loadingPromise === null) {
    initializeRemoteManagedSettingsLoadingPromise()
  }
  try {
    const cached = getRemoteManagedSettingsSyncFromCache()
    if (cached !== null) {
      resolveLoading?.()
      resolveLoading = null
    }
    const loaded = await fetchAndLoadRemoteSettings()
    if (isRemoteManagedSettingsEligible()) startBackgroundPolling()
    if (loaded !== null) {
      // Exactly one policy-source change notification; its implementation
      // resets the settings cache before running listeners.
      settingsChangeDetector.notifyChange('policySettings')
    }
  } catch (error) {
    logForDebugging(`remote settings: startup load failed: ${String(error)}`)
  } finally {
    resolveLoading?.()
    resolveLoading = null
  }
}

/**
 * The login/logout refresh: clear everything (including the eligibility
 * memo — that is what makes the recheck reflect the NEW account), then
 * re-fetch when still eligible. Does not restart polling and does not
 * re-create the loading promise.
 */
export async function refreshRemoteManagedSettings(): Promise<void> {
  await clearRemoteManagedSettingsCache()
  if (!isRemoteManagedSettingsEligible()) {
    settingsChangeDetector.notifyChange('policySettings')
    return
  }
  await fetchAndLoadRemoteSettings()
  settingsChangeDetector.notifyChange('policySettings')
}

/** Stop polling, clear all state (memo included), delete the disk file. */
export async function clearRemoteManagedSettingsCache(): Promise<void> {
  stopBackgroundPolling()
  resetSyncCache()
  loadingPromise = null
  resolveLoading = null
  try {
    unlinkSync(getSettingsPath())
  } catch {
    // ANY unlink error is ignored here.
  }
}

/**
 * Hourly poll: started at most once, only when eligible, unreferenced, and
 * registered with the shutdown cleanup registry. A tick emits the policy
 * change notification only when the serialized documents differ; every
 * error is swallowed.
 */
export function startBackgroundPolling(): void {
  if (pollTimer !== null) return
  if (!isRemoteManagedSettingsEligible()) return
  registerCleanup(async () => {
    stopBackgroundPolling()
  })
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        if (!isRemoteManagedSettingsEligible()) return
        const before = JSON.stringify(getRemoteManagedSettingsSyncFromCache())
        await fetchAndLoadRemoteSettings()
        const after = JSON.stringify(getRemoteManagedSettingsSyncFromCache())
        if (before !== after) {
          settingsChangeDetector.notifyChange('policySettings')
        }
      } catch {
        // Polling never fails the session.
      }
    })()
  }, POLL_INTERVAL_MS)
  pollTimer.unref?.()
}

/** Idempotent. */
export function stopBackgroundPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
