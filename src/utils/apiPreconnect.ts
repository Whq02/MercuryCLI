import { getOauthConfig } from '../constants/oauth.js'
import { logForDebugging } from './debug.js'
import { getApiFetch, getProxyFetchOptions } from './proxy.js'
import { getMercuryUserAgent } from './userAgent.js'

const PRECONNECT_TIMEOUT_MS = 10_000

let latchConsumed = false

export function __resetPreconnectLatchForTest(): void {
  latchConsumed = false
}

function anthropicWarmUpApplies(): boolean {
  try {
    const { getMainLoopModel } = require('./model/model.js') as typeof import('./model/model.js')
    const { declaredRouteOf } =
      require('../services/providers/routeLaw.js') as typeof import('../services/providers/routeLaw.js')
    if (declaredRouteOf(getMainLoopModel()) !== 'anthropic') return false
    const { anthropicCredentialPresence } =
      require('../services/providers/providerUsage.js') as typeof import('../services/providers/providerUsage.js')
    return anthropicCredentialPresence().credentialed
  } catch {
    return false
  }
}

export type PreconnectDecision =
  | { go: true }
  | { go: false; reason: 'signed-out' | 'proxy' | 'unix-socket' | 'client-cert' }

export function decidePreconnect(
  credentialed: boolean,
  env: Record<string, string | undefined> = process.env,
): PreconnectDecision {
  if (!credentialed) return { go: false, reason: 'signed-out' }
  const proxyPresent =
    env.https_proxy !== undefined ||
    env.HTTPS_PROXY !== undefined ||
    env.http_proxy !== undefined ||
    env.HTTP_PROXY !== undefined
  if (proxyPresent) return { go: false, reason: 'proxy' }
  if (env.ANTHROPIC_UNIX_SOCKET !== undefined) return { go: false, reason: 'unix-socket' }
  if (env.MERCURY_CLIENT_CERT !== undefined || env.MERCURY_CLIENT_KEY !== undefined) {
    return { go: false, reason: 'client-cert' }
  }
  return { go: true }
}

export function preconnectAnthropicApi(opts: { credentialed: boolean }): void {
  if (latchConsumed) return
  latchConsumed = true

  const decision = decidePreconnect(opts.credentialed)
  if (!decision.go) {
    logForDebugging(`api preconnect: skipped (${decision.reason})`)
    return
  }
  if (!anthropicWarmUpApplies()) {
    logForDebugging('api preconnect: skipped — the session does not run on an Anthropic credential')
    return
  }

  const target = process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PRECONNECT_TIMEOUT_MS)
  timer.unref?.()
  const doFetch = getApiFetch()
  void doFetch(target, {
    method: 'HEAD',
    headers: { 'user-agent': getMercuryUserAgent() },
    signal: controller.signal,
    ...(getProxyFetchOptions({ forAnthropicAPI: true }) as RequestInit),
  })
    .then(() => {
      logForDebugging('api preconnect: warm-up complete')
    })
    .catch(() => {
    })
    .finally(() => {
      clearTimeout(timer)
    })
}
