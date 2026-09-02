
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { blenderBridgeAddonDirOverride } from '../../utils/blender/bridgeGates.js'
import { locateBlender, probeBlenderVersion } from '../ide/blenderProject.js'

export const BLENDER_ADDON_MODULE = 'mercury_blender_bridge'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export interface BlenderAddonHomeCensus {
  home?: {
    path: string
    source: 'pin' | 'blender-user-scripts' | 'blender-user-resources' | 'default'
  }
  pinError?: string
  reason?: string
}

export function blenderVersionDir(version: string): string | undefined {
  const m = version.match(/^(\d+)\.(\d+)/)
  return m ? `${m[1]}.${m[2]}` : undefined
}

export function resolveBlenderAddonHome(testOpts?: {
  platform?: NodeJS.Platform
  home?: string
  env?: Record<string, string | undefined>
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
