// ============================================================================
//  unity/bridgeGates — the Unity editor-bridge's gate module (the vulcanGates
//  sibling, deliberately narrower). THE ARMING RULING: the
//  bridge RIDES MERCURY_UNITY — the one Unity switch — instead of growing a
//  MERCURY_UNITY_TOOLS sibling. Lawful because v1 splices NO prompt bytes
//  (no prompt section, no subagent-doctrine line — the tool description
//  carries the teaching), so the flag's additive tier stands and its
//  off-promise ("no Unity surface exists anywhere — byte-identical") simply
//  widens over the bridge: flag off ⇒ no `Unity` tool in the catalog, no
//  client, no token file, no harness-map line, nothing dialed. The recorded
//  alternative (a behavioral MERCURY_UNITY_TOOLS row, the exact
//  MERCURY_GODOT_TOOLS mirror) stays unbuilt until a prompt-splicing need
//  earns it.
//
//  Sandbox posture (the vulcan grammar): loopback-only by construction (the
//  client API takes a port, never a host) + a per-project token exchanged
//  via a project-private file (services/unity/bridgeToken.ts).
// ============================================================================

import { flagEnv } from '../../substrate/flagRegistry.js'
import { findUnityProjectRoot, mercuryUnityEnabled } from '../../services/ide/unityProject.js'
import { UNITY_BRIDGE_DEFAULT_PORT } from '../../services/unity/bridgeProtocol.js'
import { logForDebugging } from '../debug.js'

/** The bridge's master gate IS the Unity dev-lanes gate (the ruling above).
 *  LIVE env read every call, the cores' own reader. */
export function unityBridgeEnabled(): boolean {
  return mercuryUnityEnabled()
}

/** Catalog seam for tools.ts (the vulcanToolCatalogEnabled mirror): the
 *  `Unity` tool registers only armed AND inside a Unity project (Assets/ +
 *  ProjectSettings/ root markers) — never a ghost tool in a foreign repo;
 *  editor absence still answers with teaching notes at call time. */
export function unityBridgeToolCatalogEnabled(): boolean {
  return unityBridgeEnabled() && findUnityProjectRoot() !== undefined
}

/** The port Mercury dials (the PACKAGE listens per its own settings file;
 *  install aligns the halves — see services/unity/bridgeInstaller.ts). */
export function unityBridgePort(): number {
  const raw = flagEnv('MERCURY_UNITY_BRIDGE_PORT')
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  if (raw && raw.trim().length > 0) {
    logForDebugging(`[UNITY-BRIDGE] ignoring invalid port '${raw}' — using ${UNITY_BRIDGE_DEFAULT_PORT}`)
  }
  return UNITY_BRIDGE_DEFAULT_PORT
}

/** Proof/embedder seam: overrides the per-project token (never logged). */
export function unityBridgeTokenOverride(): string | undefined {
  const raw = flagEnv('MERCURY_UNITY_BRIDGE_TOKEN')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}
