
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  discoverBlendFiles,
  mercuryBlenderEnabled,
} from '../../services/ide/blenderProject.js'
import { BLENDER_BRIDGE_DEFAULT_PORT } from '../../services/blender/bridgeProtocol.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import * as path from 'node:path'

export function blenderBridgeEnabled(): boolean {
  return mercuryBlenderEnabled()
}

const BLEND_CONTEXT_CACHE_TTL_MS = 30_000
let blendContextCache: { at: number; cwd: string; has: boolean } | null = null

export function _resetBlenderBridgeContextCacheForTesting(): void {
  blendContextCache = null
}

function hasBlendContext(): boolean {
  const cwd = path.resolve(getCwd())
  if (
    blendContextCache &&
    blendContextCache.cwd === cwd &&
    Date.now() - blendContextCache.at < BLEND_CONTEXT_CACHE_TTL_MS
  ) {
    return blendContextCache.has
  }
  const has = discoverBlendFiles(cwd).total > 0
  blendContextCache = { at: Date.now(), cwd, has }
  return has
}

export function blenderBridgeToolCatalogEnabled(): boolean {
  return blenderBridgeEnabled() && hasBlendContext()
}

export function blenderBridgePort(): number {
  const raw = flagEnv('MERCURY_BLENDER_BRIDGE_PORT')
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed
  if (raw && raw.trim().length > 0) {
    logForDebugging(
      `[BLENDER-BRIDGE] ignoring invalid port '${raw}' — using ${BLENDER_BRIDGE_DEFAULT_PORT}`,
    )
  }
  return BLENDER_BRIDGE_DEFAULT_PORT
}

export function blenderBridgeTokenOverride(): string | undefined {
  const raw = flagEnv('MERCURY_BLENDER_BRIDGE_TOKEN')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}

export function blenderBridgeAddonDirOverride(): string | undefined {
  const raw = flagEnv('MERCURY_BLENDER_BRIDGE_ADDON_DIR')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}
