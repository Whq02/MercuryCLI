import type { ScopedMcpServerConfig } from './types.js'
import { getGlobalConfig, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'

let current: Record<string, ScopedMcpServerConfig> | undefined
let strict = false

export function seedDynamicMcpConfig(
  initial: Record<string, ScopedMcpServerConfig> | undefined,
  isStrict: boolean,
): void {
  current = initial
  strict = isStrict
}

export function watchMcpConfigChanges(onChange: () => void): () => void {
  getGlobalConfig()
  const global = subscribeGlobalConfigCache(onChange)
  const settings = settingsChangeDetector.subscribe(onChange)
  return () => { global(); settings() }
}

export function refreshDynamicMcpConfig(): void {
  current = { ...(current ?? {}) }
}

export function dynamicMcpConfigSnapshot(): Record<string, ScopedMcpServerConfig> | undefined {
  return current
}

export function isStrictMcpConfigSeed(): boolean {
  return strict
}
