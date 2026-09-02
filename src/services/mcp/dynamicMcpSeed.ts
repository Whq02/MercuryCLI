// ============================================================================
//  The interactive dynamic MCP config — ONE mutable owner (Law 9 restore).
//
//  The launch seeds it once (the --mcp-config servers + the coordination
//  server, and the strict flag); the /ide command and the IDE session-mount
//  integration MUTATE it (the bridge-config injection); the interactive MCP
//  owner (MCPConnectionManager → useManageMCPConnections) re-resolves on
//  every change. Module state, not component state: the config is process
//  truth and the face is a view.
// ============================================================================
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
      /* a broken subscriber never blocks the owner */
    }
  }
}

/** Launch-time seed — the one initial write; later writes ride the setter. */
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

/** The --ide launch flag as the session screen received it (undefined when
 *  the operator said nothing — the registry flag then decides). */
export function ideAutoConnectSeed(): boolean | undefined {
  return ideAutoConnect
}

export function dynamicMcpConfigSnapshot(): Record<string, ScopedMcpServerConfig> | undefined {
  return current
}

export function isStrictMcpConfigSeed(): boolean {
  return strict
}

/** The change door (/ide, the IDE session mount): replaces the config whole —
 *  the manager's registry diffs and reconnects; identity-preserved when
 *  nothing changed. */
export function setDynamicMcpConfig(next: Record<string, ScopedMcpServerConfig> | undefined): void {
  if (next === current) return
  current = next
  bump()
}

export function subscribeDynamicMcpConfig(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
