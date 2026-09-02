// ============================================================================
//  blender/addonHome — ONE owner for the Blender user-addon home, the
//  address every bridge artifact lives at (the add-on files, the token, the
//  port config). Blender installs are USER-scoped, not project-scoped —
//  there is no Library/ analog — so the home is the user scripts/addons dir
//  from Blender's own documented layout.
//
//  THE LADDER (every arm named; the census, read 2026-08-29):
//   1. MERCURY_BLENDER_BRIDGE_ADDON_DIR pin — AUTHORITATIVE; a pin that is
//      not an existing directory refuses BY NAME (never a silent fallback).
//   2. $BLENDER_USER_SCRIPTS/addons — Blender's own override ("Directory
//      for user scripts" — blender/blender creator/creator_args.cc).
//   3. $BLENDER_USER_RESOURCES/scripts/addons ("Replace default directory
//      of all user files" — creator_args.cc; addons live at
//      ./scripts/addons under the user dir — blender-manual
//      manual/advanced/blender_directory_layout.rst).
//   4. The per-OS default + the <major.minor> version dir, version from the
//      LANDED probeBlenderVersion on the LANDED locateBlender (the one
//      composition with the blenderProject feet; probe-class spawn, cached):
//        darwin  ~/Library/Application Support/Blender/<ver>/scripts/addons
//        win32   %APPDATA%\Blender Foundation\Blender\<ver>\scripts\addons
//        linux   $XDG_CONFIG_HOME|~/.config/blender/<ver>/scripts/addons
//      (the layout page's own path templates, read 2026-08-29).
//   No Blender located AND no pin/env ⇒ NO home — the reason names every
//   road; nothing guesses.
//
//  Legacy-addon choice: the add-on ships bl_info-style
//  into scripts/addons — "the so-called legacy add-ons will continue to be
//  supported by Blender" (blender-manual manual/advanced/extensions/
//  addons.rst, the 5.2 manual, read 2026-08-29; deprecated-not-removed
//  since 4.2). The EXTENSION road (blender_manifest.toml under
//  ./extensions) is recorded-not-built — a rebake under a manifest is the
//  upgrade if Blender ever drops legacy add-ons.
//
//  Proof: scripts/blender-bridge/prove-blender-bridge-token.ts (the ladder
//  section) — scratch dirs + env seams, no Blender.
// ============================================================================

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { blenderBridgeAddonDirOverride } from '../../utils/blender/bridgeGates.js'
import { locateBlender, probeBlenderVersion } from '../ide/blenderProject.js'

/** The add-on's module (= directory) name, both halves' one spelling. */
export const BLENDER_ADDON_MODULE = 'mercury_blender_bridge'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface BlenderAddonHomeCensus {
  /** The scripts/addons directory add-ons are materialized INTO. */
  home?: {
    path: string
    source: 'pin' | 'blender-user-scripts' | 'blender-user-resources' | 'default'
  }
  /** MERCURY_BLENDER_BRIDGE_ADDON_DIR set but not an existing directory. */
  pinError?: string
  /** Why no home resolved (names every road); set iff home is absent. */
  reason?: string
}

/** "5.2.1" | "5.2" → the version-dir spelling "5.2". */
export function blenderVersionDir(version: string): string | undefined {
  const m = version.match(/^(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}` : undefined
}

/**
 * Resolve the user addon home — filesystem + env facts plus (on the default
 * arm only) the bounded version probe of the located Blender.
 * @param testOpts proof seam: platform/home/env/version overrides.
 */
export function resolveBlenderAddonHome(testOpts?: {
  platform?: NodeJS.Platform
  home?: string
  env?: Record<string, string | undefined>
  /** Skip locate+probe and use this version string on the default arm. */
  version?: string
}): BlenderAddonHomeCensus {
  const pin = blenderBridgeAddonDirOverride()
  if (pin) {
    if (isDir(pin)) return { home: { path: pin, source: 'pin' } }
    return {
      pinError: `MERCURY_BLENDER_BRIDGE_ADDON_DIR set but ${pin} is not an existing directory — the pin names itself, no silent fallback`,
      reason: `MERCURY_BLENDER_BRIDGE_ADDON_DIR is set but ${pin} is not an existing directory`,
    }
  }
  const env = testOpts?.env ?? process.env
  const userScripts = env.BLENDER_USER_SCRIPTS
  if (userScripts && userScripts.trim() !== '') {
    return { home: { path: path.join(userScripts, 'addons'), source: 'blender-user-scripts' } }
  }
  const userResources = env.BLENDER_USER_RESOURCES
  if (userResources && userResources.trim() !== '') {
    return {
      home: { path: path.join(userResources, 'scripts', 'addons'), source: 'blender-user-resources' },
    }
  }
  // The default arm needs the version dir — from the located binary's probe.
  let version = testOpts?.version
  if (version === undefined) {
    const census = locateBlender()
    if (census.pinError) {
      return { reason: census.pinError }
    }
    if (!census.blender) {
      return {
        reason:
          'no Blender located, so the versioned user addon home is unknowable — install Blender (blender.org/download) or pin MERCURY_BLENDER_BIN, or point MERCURY_BLENDER_BRIDGE_ADDON_DIR (or Blender\'s own BLENDER_USER_SCRIPTS) at the addon directory',
      }
    }
    const probe = probeBlenderVersion(census.blender.path)
    if (!probe.version) {
      return {
        reason: `Blender at ${census.blender.path} did not answer a parseable --version (${probe.reason ?? 'unprobed'}) — pin MERCURY_BLENDER_BRIDGE_ADDON_DIR (or BLENDER_USER_SCRIPTS) to name the addon directory explicitly`,
      }
    }
    version = probe.version
  }
  const ver = blenderVersionDir(version)
  if (!ver) {
    return {
      reason: `unparseable Blender version '${version}' — pin MERCURY_BLENDER_BRIDGE_ADDON_DIR (or BLENDER_USER_SCRIPTS) to name the addon directory explicitly`,
    }
  }
  const platform = testOpts?.platform ?? process.platform
  const home = testOpts?.home ?? homedir()
  let base: string
  if (platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support', 'Blender', ver)
  } else if (platform === 'win32') {
    base = path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Blender Foundation', 'Blender', ver)
  } else {
    base = path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'blender', ver)
  }
  return { home: { path: path.join(base, 'scripts', 'addons'), source: 'default' } }
}
