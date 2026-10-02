import type { ScopedMcpServerConfig } from './types.js'

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
