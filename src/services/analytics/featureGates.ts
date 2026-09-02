
import { isEqual, memoize } from 'lodash-es'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { createSignal } from '../../utils/signal.js'
import type { GitHubActionsMetadata } from '../../utils/user.js'

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

const FORK_GATE_TABLE: Readonly<Record<string, unknown>> = {
  mercury_disable_keepalive_on_econnreset: true,
  mercury_glacier_2xr: true,
}


type FeatureGateRefreshListener = () => void | Promise<void>
const refreshed = createSignal()

function callSafe(listener: FeatureGateRefreshListener): void {
  try {
    void Promise.resolve(listener()).catch(e => {
      logError(e)
    })
  } catch (e) {
    logError(e)
  }
}

export function onFeatureGatesRefresh(
  listener: FeatureGateRefreshListener,
): () => void {
  return refreshed.subscribe(() => callSafe(listener))
}


export function getAllFeatureGates(): Record<string, unknown> {
  return { ...FORK_GATE_TABLE }
}

export function getFeatureGateConfigOverrides(): Record<string, unknown> {
  return {}
}

export function setFeatureGateConfigOverride(
  _feature: string,
  _value: unknown,
): void {
}

export function clearFeatureGateConfigOverrides(): void {}


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


function resolveGate<T>(feature: string, defaultValue: T): T {
  if (feature in FORK_GATE_TABLE) return FORK_GATE_TABLE[feature] as T
  return defaultValue
}

export const initializeFeatureGates = memoize(async (): Promise<null> => null)

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

export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return resolveGate(feature, defaultValue)
}

export function checkFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  return Boolean(resolveGate(gate, false))
}

export async function checkSecurityRestrictionGate(gate: string): Promise<boolean> {
  return Boolean(resolveGate(gate, false))
}

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


export function refreshFeatureGatesAfterAuthChange(): void {
}

export function resetFeatureGates(): void {
}

export async function refreshFeatureGates(): Promise<void> {
}

export function setupPeriodicFeatureGateRefresh(): void {
}

export function stopPeriodicFeatureGateRefresh(): void {
}
