/**
 * Mercury's OWNED feature-gate table — no remote-config client.
 *
 * WHY THIS IS A TABLE, NOT A CLIENT: the loyalty chokepoint
 * (isAnalyticsDisabled → true on every Mercury build) short-circuits every
 * remote-config read — a getter returns its inline default before touching
 * any SDK, network, or disk cache — so the resolution ladder is exactly:
 *
 *   FORK_GATE_TABLE (the operator's deliberate pin point — see below)
 *     → the caller's inline default
 *
 * Every export keeps a stable name and signature — 130 importing files
 * compile unchanged. Network fetch is REMOVED PERMANENTLY, not gated: if a
 * gate value should differ from the code's inline default, pin it in
 * FORK_GATE_TABLE (a reviewed source change), never via a remote config.
 */

import { isEqual, memoize } from 'lodash-es'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { createSignal } from '../../utils/signal.js'
import type { GitHubActionsMetadata } from '../../utils/user.js'

/**
 * Gate-targeting user attributes. The type is
 * still consumed by metadata/user plumbing; nothing is transmitted anywhere.
 */
export type FeatureGateUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

/**
 * THE OWNED STATIC GATE TABLE. Empty means "every consumer gets its inline
 * default" — byte-identical to Mercury's observed behavior since the
 * chokepoint. Pin a key here ONLY as a deliberate, reviewed decision (the
 * Cache-Clock program is the precedent: it re-owned a config this table's
 * predecessor silently zeroed). Operator-facing overrides belong in the
 * /config Gates tab (config overrides) — this table is for build-time truth.
 */
const FORK_GATE_TABLE: Readonly<Record<string, unknown>> = {
  // Headless-deadline lane (B3.5): the API retry loop's stale-pool reset —
  // rebuild the client and drop the pooled dispatcher after a server-closed
  // keep-alive replay (withRetry.ts isStaleConnectionError). Core recovery,
  // not an experiment: with the table empty the gate resolved false and the
  // reset could never arm in any build.
  mercury_disable_keepalive_on_econnreset: true,
  // FN-020 row 1 — the reviewed product decision this table's comment asks
  // for: deferred tools are announced ONCE, as persisted deferred_tools_delta
  // attachments (system-reminder rows diffed against the transcript), not
  // by the per-request <available-deferred-tools> prepend whose bytes were
  // a function of the live deferred pool — every MCP connect, reconnect,
  // disconnect and apollo entry/exit rewrote the request head and busted the
  // conversation-side prompt cache on every provider route. A fresh
  // transcript (/clear, a subagent's turn zero) re-announces the whole pool;
  // compaction re-announces through the same producer. Removing this row
  // restores the prepend byte-for-byte (utils/toolSearchFlags.ts).
  mercury_glacier_2xr: true,
}

// ---------------------------------------------------------------------------
// Refresh signal — fires when an override CHANGES (the only mutation source
// left). Subscribers (useMainLoopModel, useSkillsChange, init.ts) bake gate
// values into long-lived objects and rebuild on this signal.
// ---------------------------------------------------------------------------

type FeatureGateRefreshListener = () => void | Promise<void>
const refreshed = createSignal()

/** Call a listener with sync-throw and async-rejection both routed to logError. */
function callSafe(listener: FeatureGateRefreshListener): void {
  try {
    void Promise.resolve(listener()).catch(e => {
      logError(e)
    })
  } catch (e) {
    logError(e)
  }
}

/**
 * Register a callback for gate-value changes (now: config-override edits).
 * Returns an unsubscribe function. There is no init race anymore — values are
 * static — so no catch-up microtask is needed.
 */
export function onFeatureGatesRefresh(
  listener: FeatureGateRefreshListener,
): () => void {
  return refreshed.subscribe(() => callSafe(listener))
}

// ---------------------------------------------------------------------------
// Config overrides (/config Gates tab, ant) — preserved verbatim.
// ---------------------------------------------------------------------------

export function getAllFeatureGates(): Record<string, unknown> {
  // The owned static table IS the whole estate (the legacy
  // disk-cache keys were deleted from the schema — dead vendor state).
  return { ...FORK_GATE_TABLE }
}

export function getFeatureGateConfigOverrides(): Record<string, unknown> {
  return {}
}

/** Set or clear one config override (undefined clears); fires the refresh signal. */
export function setFeatureGateConfigOverride(
  _feature: string,
  _value: unknown,
): void {
  // No override seam exists — gate values change only through
  // FORK_GATE_TABLE (a reviewed source change).
}

export function clearFeatureGateConfigOverrides(): void {}

// ---------------------------------------------------------------------------
// Misc preserved helpers.
// ---------------------------------------------------------------------------

/** Hostname of a non-Anthropic ANTHROPIC_BASE_URL proxy (attribute helper). */
export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    if (host === 'api.anthropic.com') return undefined
    return host
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The getters — one shared ladder, every established signature preserved.
// ---------------------------------------------------------------------------

function resolveGate<T>(feature: string, defaultValue: T): T {
  if (feature in FORK_GATE_TABLE) return FORK_GATE_TABLE[feature] as T
  return defaultValue
}

/** No client exists — resolves immediately. Kept for its callers' shape. */
export const initializeFeatureGates = memoize(async (): Promise<null> => null)

/** @deprecated kept for signature parity; identical to the cached getter. */
export async function getFeatureValue_DEPRECATED<T>(
  feature: string,
  defaultValue: T,
): Promise<T> {
  return resolveGate(feature, defaultValue)
}

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  return resolveGate(feature, defaultValue)
}

/** @deprecated the TTL never fetched anything; identical to the cached getter. */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return resolveGate(feature, defaultValue)
}

/** Boolean gate. Default false, ladder-resolved. */
export function checkFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  return Boolean(resolveGate(gate, false))
}

/**
 * Security-restriction gate. Fail-CLOSED to `false` when no
 * table value exists: false
 * unless an override/table entry deliberately sets it.
 */
export async function checkSecurityRestrictionGate(gate: string): Promise<boolean> {
  return Boolean(resolveGate(gate, false))
}

/** Entitlement gate (was cached-or-blocking). Static now — never blocks. */
export async function checkGate_CACHED_OR_BLOCKING(gate: string): Promise<boolean> {
  return Boolean(resolveGate(gate, false))
}

export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return resolveGate(configName, defaultValue)
}

export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return resolveGate(configName, defaultValue)
}

// ---------------------------------------------------------------------------
// Lifecycle no-ops — the machinery these managed does not exist. Kept so
// auth flows / shutdown paths / tests calling them stay source-compatible.
// ---------------------------------------------------------------------------

export function refreshFeatureGatesAfterAuthChange(): void {
  // Static table — auth changes cannot change gate values.
}

export function resetFeatureGates(): void {
  // Nothing latched beyond env-override memoization, which is process-stable
  // by design (eval harnesses set it before boot).
}

export async function refreshFeatureGates(): Promise<void> {
  // Static table — nothing to refresh.
}

export function setupPeriodicFeatureGateRefresh(): void {
  // Static table — no timer to run.
}

export function stopPeriodicFeatureGateRefresh(): void {
  // Static table — no timer to stop.
}
