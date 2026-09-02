
import { flagEnv } from '../../substrate/flagRegistry.js'
import { findUnityProjectRoot, mercuryUnityEnabled } from '../../services/ide/unityProject.js'
import { UNITY_BRIDGE_DEFAULT_PORT } from '../../services/unity/bridgeProtocol.js'
import { logForDebugging } from '../debug.js'

export function unityBridgeEnabled(): boolean {
  return mercuryUnityEnabled()
}

export function unityBridgeToolCatalogEnabled(): boolean {
  return unityBridgeEnabled() && findUnityProjectRoot() !== undefined
}

export function unityBridgePort(): number {
  const raw = flagEnv('MERCURY_UNITY_BRIDGE_PORT')
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  if (raw && raw.trim().length > 0) {
    logForDebugging(`[UNITY-BRIDGE] ignoring invalid port '${raw}' — using ${UNITY_BRIDGE_DEFAULT_PORT}`)
  }
  return UNITY_BRIDGE_DEFAULT_PORT
}

export function unityBridgeTokenOverride(): string | undefined {
  const raw = flagEnv('MERCURY_UNITY_BRIDGE_TOKEN')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}
