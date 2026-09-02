import type { ScopedMcpServerConfig } from './types.js'

let current: Record<string, ScopedMcpServerConfig> | undefined
let strict = false
let ideAutoConnect: boolean | undefined
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
  opts?: { ideAutoConnect?: boolean },
): void {
  current = initial
  strict = isStrict
  ideAutoConnect = opts?.ideAutoConnect
  bump()
}

export function ideAutoConnectSeed(): boolean | undefined {
  return ideAutoConnect
}

export function dynamicMcpConfigSnapshot(): Record<string, ScopedMcpServerConfig> | undefined {
  return current
}

export function isStrictMcpConfigSeed(): boolean {
  return strict
}

export function setDynamicMcpConfig(next: Record<string, ScopedMcpServerConfig> | undefined): void {
  if (next === current) return
  current = next
  bump()
}

export function subscribeDynamicMcpConfig(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
