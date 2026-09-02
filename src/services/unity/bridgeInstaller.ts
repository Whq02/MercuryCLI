// ============================================================================
//  bridgeInstaller — materializes the bundled com.mercury.unity-bridge
//  editor package into a Unity project (the Mercury-side halves of
//  unity_status / unity_bridge_install / unity_bridge_uninstall — the Unity
//  tool routes those ops here, they never reach the wire). All writes are
//  plain fs through the tool's permissioned call.
//
//  DELIBERATELY SIMPLER THAN THE GODOT SIBLING (recorded per the ruling):
//  Unity's embedded-package law does the enabling for us — "Any package
//  that appears under your project's Packages folder is embedded in that
//  project" and "Embedded packages don't need to appear in the project
//  manifest as a dependency" (docs.unity3d.com Manual/upm-embed, read
//  2026-08-29) — so there is NO manifest edit, NO project-settings enable flag, NO
//  autoload entry, and none of the addonInstaller's fenced project.godot
//  mutation machinery. The three artifacts are: the package files under
//  Packages/com.mercury.unity-bridge/, the token under Library/, and the
//  OPTIONAL port-alignment file ProjectSettings/MercuryUnityBridge.json
//  (ours alone — the editor never writes it; present only when Mercury's
//  MERCURY_UNITY_BRIDGE_PORT differs from the default so both halves
//  agree; removed when the default returns).
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { unityBridgeEnabled, unityBridgePort } from '../../utils/unity/bridgeGates.js'
import { UNITY_BRIDGE_DEFAULT_PORT } from './bridgeProtocol.js'
import { UNITY_BRIDGE_DIGEST, UNITY_BRIDGE_FILES } from './bridgeFiles.generated.js'
import { getUnityBridgeClient, probeUnityBridgeReachable, unityBridgeHint } from './bridgeClient.js'
import { ensureUnityBridgeToken, readUnityBridgeToken, unityBridgeTokenPath } from './bridgeToken.js'

const PACKAGE_DIR = path.join('Packages', 'com.mercury.unity-bridge')
const SETTINGS_REL = path.join('ProjectSettings', 'MercuryUnityBridge.json')

export interface UnityBridgeInstallStatus {
  installed: boolean
  digestMatch: boolean
  bundledFiles: number
}

export function unityBridgeInstallStatus(projectRoot: string): UnityBridgeInstallStatus {
  const packageRoot = path.join(projectRoot, PACKAGE_DIR)
  const installed = existsSync(path.join(packageRoot, 'package.json'))
  let digestMatch = installed && UNITY_BRIDGE_FILES.length > 0
  if (digestMatch) {
    for (const f of UNITY_BRIDGE_FILES) {
      try {
        if (readFileSync(path.join(packageRoot, f.path), 'utf8') !== f.content) {
          digestMatch = false
          break
        }
      } catch {
        digestMatch = false
        break
      }
    }
  }
  return { installed, digestMatch, bundledFiles: UNITY_BRIDGE_FILES.length }
}

/** The port the PACKAGE will listen on (the alignment file, else the
 *  default) — the other half of unityBridgePort(). */
export function readProjectBridgePort(projectRoot: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(projectRoot, SETTINGS_REL), 'utf8')) as {
      port?: unknown
    }
    return typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535
      ? raw.port
      : undefined
  } catch {
    return undefined
  }
}

export function applyUnityBridgeInstall(projectRoot: string): string {
  if (UNITY_BRIDGE_FILES.length === 0) {
    return 'the bridge bundle is empty (a dev build before regen-bridge ran) — run: node scripts/unity-bridge/regen-bridge.mjs and rebuild'
  }
  const packageRoot = path.join(projectRoot, PACKAGE_DIR)
  for (const f of UNITY_BRIDGE_FILES) {
    const target = path.join(packageRoot, f.path)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, f.content)
  }
  const port = unityBridgePort()
  const settingsFile = path.join(projectRoot, SETTINGS_REL)
  let portNote = ''
  if (port !== UNITY_BRIDGE_DEFAULT_PORT) {
    mkdirSync(path.dirname(settingsFile), { recursive: true })
    writeFileSync(settingsFile, JSON.stringify({ port }) + '\n')
    portNote = `; ${SETTINGS_REL} set to ${port} (matches MERCURY_UNITY_BRIDGE_PORT)`
  } else if (existsSync(settingsFile)) {
    rmSync(settingsFile, { force: true })
    portNote = `; ${SETTINGS_REL} removed (both halves on the default ${UNITY_BRIDGE_DEFAULT_PORT})`
  }
  ensureUnityBridgeToken(projectRoot)
  return [
    `installed ${UNITY_BRIDGE_FILES.length} package files under ${PACKAGE_DIR}/ (bundle ${UNITY_BRIDGE_DIGEST.slice(0, 12)}…; embedded package — no manifest entry needed)`,
    `session token ready (${path.join('Library', 'mercury-unity-bridge-token')})${portNote}`,
    `the editor imports + compiles the package on focus/refresh — then op:"unity_status" should report it reachable on 127.0.0.1:${port}`,
  ].join('\n')
}

export function applyUnityBridgeUninstall(projectRoot: string): string {
  const packageRoot = path.join(projectRoot, PACKAGE_DIR)
  const existed = existsSync(packageRoot)
  rmSync(packageRoot, { recursive: true, force: true })
  // The editor may have generated a .meta beside the embedded package dir.
  rmSync(packageRoot + '.meta', { force: true })
  rmSync(unityBridgeTokenPath(projectRoot), { force: true })
  const settingsFile = path.join(projectRoot, SETTINGS_REL)
  const hadSettings = existsSync(settingsFile)
  rmSync(settingsFile, { force: true })
  const settingsNote = hadSettings ? ', port-alignment file removed' : ''
  return existed
    ? `com.mercury.unity-bridge removed: package files deleted, token file removed${settingsNote} — the editor drops the compiled assembly on its next refresh`
    : `com.mercury.unity-bridge was not installed; token + alignment file cleaned anyway${settingsNote}`
}

export async function describeUnityBridgeStatus(projectRoot: string): Promise<string> {
  const s = unityBridgeInstallStatus(projectRoot)
  const port = unityBridgePort()
  const client = getUnityBridgeClient()
  // The client's live state answers reachability without touching the wire;
  // the raw probe (safe by the hello-time accept law) covers the rest.
  const reachable = client?.status() === 'ready' ? true : await probeUnityBridgeReachable(port)
  const lines = [
    `flag: ${unityBridgeEnabled() ? 'armed (MERCURY_UNITY)' : 'OFF'} · project: ${projectRoot}`,
    `package: ${
      s.installed
        ? `installed${
            s.digestMatch
              ? ', matches the bundled version'
              : s.bundledFiles === 0
                ? ' (bundle empty — dev build)'
                : ', DRIFTED from the bundle (unity_bridge_install refreshes)'
          }`
        : 'NOT installed (op:"unity_bridge_install")'
    }`,
    `token file: ${readUnityBridgeToken(projectRoot) ? 'present' : 'absent (unity_bridge_install writes it)'}`,
    `editor bridge: ${reachable ? `answering on 127.0.0.1:${port}` : `not answering on 127.0.0.1:${port} — ${unityBridgeHint(port)}`}`,
    `client: ${client ? client.status() : 'unavailable'}`,
  ]
  const packagePort = readProjectBridgePort(projectRoot) ?? UNITY_BRIDGE_DEFAULT_PORT
  if (packagePort !== port) {
    lines.push(
      `PORT MISMATCH: Mercury dials ${port} but the package listens on ${packagePort} (${SETTINGS_REL}) — op:"unity_bridge_install" aligns them`,
    )
  }
  return lines.join('\n')
}
