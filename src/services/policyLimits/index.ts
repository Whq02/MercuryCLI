import { createHash } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import axios, { AxiosError } from 'axios'

import { OAUTH_BETA_HEADER, getOauthConfig } from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { classifyAxiosError } from '../../utils/errors.js'
import { isFirstPartyAnthropicBaseUrl } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getAnthropicClientUserAgent } from '../../utils/userAgent.js'
import { getRetryDelay } from '../api/withRetry.js'
import {
  PolicyLimitsResponseSchema,
  type PolicyLimitsFetchResult,
  type PolicyLimitsResponse,
} from './types.js'

type Restrictions = PolicyLimitsResponse['restrictions']

const CACHE_FILE_NAME = 'policy-limits.json'
const CACHE_FILE_MODE = 0o600
const FETCH_TIMEOUT_MS = 10_000
const MAX_RETRIES = 5
const LOADING_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 60 * 60 * 1000

const DENY_ON_MISS_POLICIES = new Set(['allow_product_feedback'])


let sessionCache: Restrictions | null = null
let loadingPromise: Promise<void> | null = null
let resolveLoading: (() => void) | null = null
let pollTimer: NodeJS.Timeout | null = null
let cleanupRegistered = false

function cacheFilePath(): string {
  return join(getMercuryHome(), CACHE_FILE_NAME)
}


export function isPolicyLimitsEligible(): boolean {
  if (!isFirstPartyAnthropicBaseUrl()) return false
  try {
    const { key } = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true })
    if (key) return true
  } catch {
  }
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) return false
  if (!tokens.scopes.includes('user:inference')) return false
  return tokens.subscriptionType === 'enterprise' || tokens.subscriptionType === 'team'
}


function restrictionsChecksum(restrictions: Restrictions): string {
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = sortKeys((value as Record<string, unknown>)[key])
      }
      return sorted
    }
    return value
  }
  const canonical = JSON.stringify(sortKeys(restrictions))
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

async function fetchPolicyLimits(cached: Restrictions | null): Promise<PolicyLimitsFetchResult> {
  await checkAndRefreshOAuthTokenIfNeeded()

  const headers: Record<string, string> = {
    'User-Agent': getAnthropicClientUserAgent(),
  }
  let apiKey: string | null = null
  try {
    apiKey = getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).key
  } catch {
  }
  if (apiKey) {
    headers['x-api-key'] = apiKey
  } else {
    const tokens = getClaudeAIOAuthTokens()
    if (!tokens?.accessToken) {
      return { success: false, retryable: false, error: 'no authentication available' }
    }
    headers['Authorization'] = `Bearer ${tokens.accessToken}`
    headers['anthropic-beta'] = OAUTH_BETA_HEADER
  }
  if (cached !== null) {
    headers['If-None-Match'] = `"${restrictionsChecksum(cached)}"`
  }

  try {
    const response = await axios.get(`${getOauthConfig().BASE_API_URL}/api/claude_code/policy_limits`, {
      headers,
      timeout: FETCH_TIMEOUT_MS,
      validateStatus: status => status === 200 || status === 304 || status === 404,
    })
    if (response.status === 304) return { success: true, restrictions: null }
    if (response.status === 404) return { success: true, restrictions: {} }
    const parsed = PolicyLimitsResponseSchema.safeParse(response.data)
    if (!parsed.success) {
      logForDebugging(`policy limits: response failed the schema: ${parsed.error.message}`)
      return {
        success: false,
        retryable: true,
        error: 'policy limits response has an unexpected format',
      }
    }
    return { success: true, restrictions: parsed.data.restrictions }
  } catch (error) {
    const kind = classifyAxiosError(error).kind
    if (kind === 'auth') {
      return { success: false, retryable: false, error: 'authentication failed' }
    }
    if (kind === 'timeout') {
      return { success: false, retryable: true, error: 'policy limits request timed out' }
    }
    if (kind === 'network') {
      return { success: false, retryable: true, error: 'network failure fetching policy limits' }
    }
    return {
      success: false,
      retryable: true,
      error: classifyAxiosError(error).message,
    }
  }
}

async function fetchWithRetry(cached: Restrictions | null): Promise<PolicyLimitsFetchResult> {
  let result = await fetchPolicyLimits(cached)
  for (let attempt = 1; attempt <= MAX_RETRIES && !result.success && result.retryable; attempt++) {
    const delay = getRetryDelay(attempt)
    logForDebugging(`policy limits: retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay)}ms`)
    await new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, delay)
      timer.unref?.()
    })
    result = await fetchPolicyLimits(cached)
  }
  return result
}


let cacheProblems: string[] = []

export function getPolicyCacheProblems(): string[] {
  return [...cacheProblems]
}

function loadCacheFile(): Restrictions | null {
  cacheProblems = []
  let raw: string
  try {
    raw = readFileSync(cacheFilePath(), 'utf-8')
  } catch {
    return null
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    cacheProblems = [`cache file unparseable: ${String(error).slice(0, 120)}`]
    logForDebugging(`policy limits: ${cacheProblems[0]}`)
    return null
  }
  const parsed = PolicyLimitsResponseSchema.safeParse(doc)
  if (parsed.success) return parsed.data.restrictions
  const rec = (doc as { restrictions?: unknown } | null)?.restrictions
  if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
    cacheProblems = ['cache restrictions map malformed — no entries salvageable']
    logForDebugging(`policy limits: ${cacheProblems[0]}`)
    return null
  }
  const kept: Restrictions = {}
  const problems: string[] = []
  for (const [name, entry] of Object.entries(rec)) {
    const allowed = (entry as { allowed?: unknown } | null)?.allowed
    if (typeof entry === 'object' && entry !== null && typeof allowed === 'boolean') {
      kept[name] = { allowed }
    } else {
      problems.push(`entry '${name}' malformed (dropped — reads unrestricted)`)
    }
  }
  cacheProblems = problems
  for (const problem of problems) logForDebugging(`policy limits: ${problem}`)
  return Object.keys(kept).length > 0 ? kept : null
}

function writeCacheFile(restrictions: Restrictions): void {
  writeFileSync(
    cacheFilePath(),
    JSON.stringify({ restrictions }, null, 2),
    { mode: CACHE_FILE_MODE },
  )
}

function deleteCacheFile(): void {
  try {
    if (existsSync(cacheFilePath())) unlinkSync(cacheFilePath())
  } catch (error) {
    logForDebugging(`policy limits: cache file delete failed: ${String(error)}`)
  }
}


async function fetchAndCachePolicyLimits(): Promise<Restrictions | null> {
  if (!isPolicyLimitsEligible()) return null
  const cached = sessionCache ?? loadCacheFile()
  try {
    const result = await fetchWithRetry(cached)
    if (result.success) {
      if (result.restrictions === null) {
        if (cached !== null) {
          sessionCache = cached
          return cached
        }
        sessionCache = {}
        deleteCacheFile()
        return {}
      }
      if (Object.keys(result.restrictions).length === 0) {
        sessionCache = {}
        deleteCacheFile()
        return {}
      }
      sessionCache = result.restrictions
      writeCacheFile(result.restrictions)
      return result.restrictions
    }
    if (cached !== null) {
      logForDebugging(`policy limits: fetch failed (${result.error}); using the stale cache`)
      sessionCache = cached
      return cached
    }
    return null
  } catch (error) {
    if (cached !== null) {
      logForDebugging(`policy limits: fetch threw (${String(error)}); using the stale cache`)
      sessionCache = cached
      return cached
    }
    return null
  }
}

export function readPolicyCacheState(): {
  present: boolean
  restrictions: Restrictions | null
  problems: string[]
} {
  const present = existsSync(cacheFilePath())
  const restrictions = present ? loadCacheFile() : null
  return { present, restrictions, problems: getPolicyCacheProblems() }
}


function readRestrictionsSync(): Restrictions | null {
  if (!isPolicyLimitsEligible()) return null
  if (sessionCache !== null) return sessionCache
  const fromDisk = loadCacheFile()
  if (fromDisk !== null) {
    sessionCache = fromDisk
    return fromDisk
  }
  return null
}

export function isPolicyAllowed(policy: string): boolean {
  const restrictions = readRestrictionsSync()
  if (restrictions === null) {
    if (isEssentialTrafficOnly() && DENY_ON_MISS_POLICIES.has(policy)) return false
    return true
  }
  const entry = restrictions[policy]
  if (entry === undefined) return true
  return entry.allowed
}


export function initializePolicyLimitsLoadingPromise(): void {
  if (!isPolicyLimitsEligible()) return
  if (loadingPromise !== null) return
  loadingPromise = new Promise<void>(resolvePromise => {
    resolveLoading = resolvePromise
    const timer = setTimeout(() => {
      logForDebugging('policy limits: loading promise self-resolved after 30s')
      resolvePromise()
    }, LOADING_TIMEOUT_MS)
    timer.unref?.()
  })
}

export async function waitForPolicyLimitsToLoad(): Promise<void> {
  if (loadingPromise === null) return
  await loadingPromise
}

export async function loadPolicyLimits(): Promise<void> {
  if (loadingPromise === null) {
    loadingPromise = new Promise<void>(resolvePromise => {
      resolveLoading = resolvePromise
    })
  }
  try {
    await fetchAndCachePolicyLimits()
    if (isPolicyLimitsEligible()) startBackgroundPolling()
  } finally {
    resolveLoading?.()
    resolveLoading = null
  }
}

export async function refreshPolicyLimits(): Promise<void> {
  clearPolicyLimitsCache()
  if (!isPolicyLimitsEligible()) return
  await fetchAndCachePolicyLimits()
  logForDebugging('policy limits: refreshed after an authentication change')
}

export function clearPolicyLimitsCache(): void {
  stopBackgroundPolling()
  sessionCache = null
  loadingPromise = null
  resolveLoading = null
  deleteCacheFile()
}

export function startBackgroundPolling(): void {
  if (pollTimer !== null) return
  if (!isPolicyLimitsEligible()) return
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      stopBackgroundPolling()
    })
  }
  pollTimer = setInterval(() => {
    const before = JSON.stringify(sessionCache)
    void fetchAndCachePolicyLimits()
      .then(() => {
        const after = JSON.stringify(sessionCache)
        if (before !== after) {
          logForDebugging('policy limits: restrictions changed on background poll')
        }
      })
      .catch(() => {})
  }, POLL_INTERVAL_MS)
  pollTimer.unref?.()
}

export function stopBackgroundPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
