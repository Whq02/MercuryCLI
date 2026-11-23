import type { ScopedMcpServerConfig } from '../mcp-shapes/mcpServerRecords.js'
import { getGlobalConfig, subscribeGlobalConfigCache } from '../../platform/config/globalConfig.js'
import { settingsChangeDetector } from '../../platform/settings/changeDetector.js'

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
