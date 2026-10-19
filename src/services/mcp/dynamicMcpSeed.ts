import type { ScopedMcpServerConfig } from './types.js'
import { getGlobalConfig, subscribeGlobalConfigCache } from '../../utils/config/globalConfig.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'

let current: Record<string, ScopedMcpServerConfig> | undefined
let strict = false
const listeners = new Set<() => void>()

function bump(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
    }
  }
}

export function seedDynamicMcpConfig(
  initial: Record<string, ScopedMcpServerConfig> | undefined,
  isStrict: boolean,
): void {
  current = initial
  strict = isStrict
  bump()
}

export function watchMcpConfigChanges(onChange: () => void): () => void {
  getGlobalConfig()
  const global = subscribeGlobalConfigCache(onChange)
  const settings = settingsChangeDetector.subscribe(onChange)
  return () => { global(); settings() }
}

export function refreshDynamicMcpConfig(): void {
  current = { ...(current ?? {}) }
  bump()
}

export function dynamicMcpConfigSnapshot(): Record<string, ScopedMcpServerConfig> | undefined {
  return current
}

export function isStrictMcpConfigSeed(): boolean {
  return strict
}

export function subscribeDynamicMcpConfig(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
