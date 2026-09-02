// ============================================================================
//  bridgeInstaller — materializes the bundled mercury_blender_bridge add-on
//  into the Blender USER ADDON HOME (the Mercury-side halves of
//  blender_status / blender_bridge_install / blender_bridge_uninstall — the
//  Blender tool routes those ops here, they never reach the wire). All
//  writes are plain fs through the tool's permissioned call.
//
//  THE ADDON ROAD (the ruling; the vulcan/unity installers' sibling with
//  the Blender differences recorded):
//   · the home comes from services/blender/addonHome.ts (pin →
//     BLENDER_USER_SCRIPTS → BLENDER_USER_RESOURCES → per-OS default with
//     the probed version); NO home ⇒ install REFUSES with the reason that
//     names every road — nothing guesses, nothing is written.
//   · THREE artifacts, all INSIDE <home>/mercury_blender_bridge/: the
//     add-on files, the token, and the OPTIONAL config.json (ours alone —
//     present only when MERCURY_BLENDER_BRIDGE_PORT differs from the
//     default so both halves agree; removed when the default returns).
//     Uninstall removes the directory WHOLE — token and config go with it.
//   · ENABLEMENT IS NEVER AUTOMATED: Blender persists add-on enablement in
//     userpref.blend, a binary file with no honest text edit (the
//     project.godot arm of the vulcan road has NO Blender equivalent).
//     Install RECEIPTS teach both enable roads verbatim; status reports
//     enablement as unknowable-from-disk and points at the reachability
//     probe as the proof (answering = installed + enabled + open).
// ============================================================================

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { blenderBridgeEnabled, blenderBridgePort } from '../../utils/blender/bridgeGates.js'
import { BLENDER_BRIDGE_DEFAULT_PORT } from './bridgeProtocol.js'
import { BLENDER_BRIDGE_DIGEST, BLENDER_BRIDGE_FILES } from './bridgeFiles.generated.js'
import {
  getBlenderBridgeClient,
  probeBlenderBridgeReachable,
  blenderBridgeHint,
} from './bridgeClient.js'
import { ensureBlenderBridgeToken, readBlenderBridgeToken } from './bridgeToken.js'
import { BLENDER_ADDON_MODULE, resolveBlenderAddonHome } from './addonHome.js'
import { locateBlender } from '../ide/blenderProject.js'

export interface BlenderBridgeInstallStatus {
  installed: boolean
  digestMatch: boolean
  bundledFiles: number
}

const ENABLE_TEACHING = (blenderSpelling: string): string =>
  `ENABLE IT (Mercury never automates this): in Blender, Edit > Preferences > Add-ons, search "Mercury", tick the box — or run yourself:\n` +
  `  ${blenderSpelling} --python-expr "import bpy; bpy.ops.preferences.addon_enable(module='${BLENDER_ADDON_MODULE}'); bpy.ops.wm.save_userpref()"`

function addonDir(addonHome: string): string {
  return path.join(addonHome, BLENDER_ADDON_MODULE)
}

function configPath(addonHome: string): string {
  return path.join(addonDir(addonHome), 'config.json')
}

export function blenderBridgeInstallStatus(addonHome: string): BlenderBridgeInstallStatus {
  const installed = existsSync(path.join(addonDir(addonHome), '__init__.py'))
  let digestMatch = installed && BLENDER_BRIDGE_FILES.length > 0
  if (digestMatch) {
    for (const f of BLENDER_BRIDGE_FILES) {
      try {
        if (readFileSync(path.join(addonHome, f.path), 'utf8') !== f.content) {
          digestMatch = false
          break
        }
      } catch {
        digestMatch = false
        break
      }
    }
  }
  return { installed, digestMatch, bundledFiles: BLENDER_BRIDGE_FILES.length }
}

/** The port the ADD-ON will listen on (config.json beside it, else the
 *  default) — the other half of blenderBridgePort(). */
export function readAddonBridgePort(addonHome: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(configPath(addonHome), 'utf8')) as { port?: unknown }
    return typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535
      ? raw.port
      : undefined
  } catch {
    return undefined
  }
}

export function applyBlenderBridgeInstall(): string {
  if (BLENDER_BRIDGE_FILES.length === 0) {
    return 'the bridge bundle is empty (a dev build before regen-bridge ran) — run: node scripts/blender-bridge/regen-bridge.mjs and rebuild'
  }
  const census = resolveBlenderAddonHome()
  if (!census.home) {
    return `no addon home to install into: ${census.reason ?? 'unresolvable'} — nothing was written`
  }
  const home = census.home.path
  for (const f of BLENDER_BRIDGE_FILES) {
    const target = path.join(home, f.path)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, f.content)
  }
  const port = blenderBridgePort()
  let portNote = ''
  if (port !== BLENDER_BRIDGE_DEFAULT_PORT) {
    writeFileSync(configPath(home), JSON.stringify({ port }) + '\n')
    portNote = `; config.json set to ${port} (matches MERCURY_BLENDER_BRIDGE_PORT)`
  } else if (existsSync(configPath(home))) {
    rmSync(configPath(home), { force: true })
    portNote = `; config.json removed (both halves on the default ${BLENDER_BRIDGE_DEFAULT_PORT})`
  }
  ensureBlenderBridgeToken(home)
  const blenderSpelling = locateBlender().blender?.path ?? 'blender'
  return [
    `installed ${BLENDER_BRIDGE_FILES.length} add-on files under ${addonDir(home)}/ (bundle ${BLENDER_BRIDGE_DIGEST.slice(0, 12)}…; home source: ${census.home.source})`,
    `session token ready (${path.join(BLENDER_ADDON_MODULE, 'token')})${portNote}`,
    ENABLE_TEACHING(blenderSpelling),
    `then op:"blender_status" should report the bridge answering on 127.0.0.1:${port}`,
  ].join('\n')
}

export function applyBlenderBridgeUninstall(): string {
  const census = resolveBlenderAddonHome()
  if (!census.home) {
    return `no addon home resolved (${census.reason ?? 'unresolvable'}) — nothing to remove`
  }
  const dir = addonDir(census.home.path)
  const existed = existsSync(dir)
  rmSync(dir, { recursive: true, force: true })
  return existed
    ? `${BLENDER_ADDON_MODULE} removed WHOLE from ${census.home.path} (add-on files, token, and any config.json) — disable/forget it in Blender's Preferences if it was enabled; a running Blender drops the listener on disable or restart`
    : `${BLENDER_ADDON_MODULE} was not installed under ${census.home.path}; nothing to remove`
}

export async function describeBlenderBridgeStatus(): Promise<string> {
  const port = blenderBridgePort()
  const census = resolveBlenderAddonHome()
  const lines: string[] = [
    `flag: ${blenderBridgeEnabled() ? 'armed (MERCURY_BLENDER)' : 'OFF'}`,
  ]
  if (!census.home) {
    lines.push(`addon home: UNRESOLVED — ${census.reason ?? 'unresolvable'}`)
    lines.push(`bridge: not probed (no install address)`)
    return lines.join('\n')
  }
  const home = census.home.path
  lines.push(`addon home: ${home} (${census.home.source})`)
  const s = blenderBridgeInstallStatus(home)
  lines.push(
    `add-on: ${
      s.installed
        ? `installed${
            s.digestMatch
              ? ', matches the bundled version'
              : s.bundledFiles === 0
                ? ' (bundle empty — dev build)'
                : ', DRIFTED from the bundle (blender_bridge_install refreshes)'
          }`
        : 'NOT installed (op:"blender_bridge_install")'
    }`,
  )
  lines.push(
    'enabled: unknowable from disk (Blender keeps enablement in the binary userpref.blend) — an ANSWERING bridge below is the proof of installed + enabled + open',
  )
  lines.push(`token file: ${readBlenderBridgeToken(home) ? 'present' : 'absent (blender_bridge_install writes it)'}`)
  const client = getBlenderBridgeClient()
  const reachable = client?.status() === 'ready' ? true : await probeBlenderBridgeReachable(port)
  lines.push(
    `bridge: ${reachable ? `answering on 127.0.0.1:${port}` : `not answering on 127.0.0.1:${port} — ${blenderBridgeHint(port)}`}`,
  )
  lines.push(`client: ${client ? client.status() : 'unavailable'}`)
  const addonPort = readAddonBridgePort(home) ?? BLENDER_BRIDGE_DEFAULT_PORT
  if (addonPort !== port) {
    lines.push(
      `PORT MISMATCH: Mercury dials ${port} but the add-on listens on ${addonPort} (${path.join(BLENDER_ADDON_MODULE, 'config.json')}) — op:"blender_bridge_install" aligns them (Blender re-reads it on add-on re-enable or restart)`,
    )
  }
  return lines.join('\n')
}
