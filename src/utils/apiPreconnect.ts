/**
 * One-shot, fire-and-forget TCP/TLS warm-up of the API origin at the ROOT
 * action's boot (the cockpit and print-mode paths — main.tsx's preAction arm
 * dispatches it after init), so the handshake overlaps startup work. Its
 * socket is a live handle until the origin answers or the connect times
 * out, which is why no headless subcommand dispatches it: a verb whose work
 * is done must not wait on a warm-up it never uses.
 */
import { getOauthConfig } from '../constants/oauth.js'
import { logForDebugging } from './debug.js'
import { getApiFetch, getProxyFetchOptions } from './proxy.js'
import { getMercuryUserAgent } from './userAgent.js'

const PRECONNECT_TIMEOUT_MS = 10_000

/** Consumed BEFORE the skip checks — a skipping call burns the one shot. */
let latchConsumed = false

/** Proof seam: re-arm the one shot (a prover drives several homes). */
export function __resetPreconnectLatchForTest(): void {
  latchConsumed = false
}

/**
 * The warm-up targets the ANTHROPIC origin, so it serves a boot whose first
 * request goes there: the session's default lane is Anthropic AND an
 * Anthropic credential exists. On a sovereign home (a non-Anthropic default
 * — the operator's OpenRouter free tier — or no Anthropic credential at
 * all) the HEAD is a phone-home with nothing to warm, so it does not fire.
 * The gate reads the same owners the session's own admission reads (the
 * routing law over the resolved main-loop model; the presence owner), by
 * call-time require so the boot's static graph never grows for a gate.
 * Any failure answers false: a boot never crashes on a warm-up, and never
 * warms a pool it cannot vouch for.
 */
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

/**
 * Pure decision core — zero I/O, provable anywhere.
 *
 * SIGNED-OUT IS A SKIP: a plain signed-out boot reached api.anthropic.com
 * (HEAD / with the product agent) before any consent surface — the one
 * outbound request on a boot that had nothing to send, and the ledger's
 * MA6 verify ("zero outbound on a plain signed-out boot") failed on it
 * (TASK-014 w1-f14-01 · w3-f01-01 · w3-f02-01 · w3-f10-02). A warm-up
 * serves the first model request; with no first-party credential there
 * is no request to serve.
 *
 * The transport skips are plain PRESENCE tests (not truthiness): a proxy,
 * a unix socket or a client certificate/key means a different transport
 * that would not share the warmed pool. An extra-CA variable is
 * deliberately not a skip.
 */
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

/**
 * Warm the API connection pool — only for a boot that holds a first-party
 * credential (the caller answers that; see decidePreconnect). Must run
 * AFTER extra CA certs and global agents are configured.
 */
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
    // The warm-up presents the product identity like every other
    // connection (undici would otherwise spell its own library agent).
    headers: { 'user-agent': getMercuryUserAgent() },
    signal: controller.signal,
    ...(getProxyFetchOptions({ forAnthropicAPI: true }) as RequestInit),
  })
    .then(() => {
      logForDebugging('api preconnect: warm-up complete')
    })
    .catch(() => {
      // All failures swallowed.
    })
    .finally(() => {
      clearTimeout(timer)
    })
}
