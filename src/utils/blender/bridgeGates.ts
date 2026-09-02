// ============================================================================
//  blender/bridgeGates — the Blender add-on-bridge's gate module (the
//  unity/bridgeGates sibling). THE ARMING RULING (the unity
//  one-switch argument transferred verbatim): the bridge RIDES
//  MERCURY_BLENDER — the one Blender switch — instead of growing a
//  MERCURY_BLENDER_TOOLS sibling. Lawful because v1 splices NO prompt bytes
//  (no prompt section, no subagent-doctrine line — the tool description
//  carries the teaching), so the flag's additive tier stands and its
//  off-promise ("no Blender surface exists anywhere — byte-identical")
//  simply widens over the bridge: flag off ⇒ no `Blender` tool in the
//  catalog, no client, no token file, no harness-map line, nothing dialed.
//
//  Sandbox posture (the vulcan grammar): loopback-only by construction (the
//  client API takes a port, never a host) + a per-INSTALL token exchanged
//  via a file inside the installed add-on dir
//  (services/blender/bridgeToken.ts) — user-scoped because the add-on home
//  is user-scoped, unlike the per-project Unity token; the registry row
//  records the difference.
// ============================================================================

import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  discoverBlendFiles,
  mercuryBlenderEnabled,
} from '../../services/ide/blenderProject.js'
import { BLENDER_BRIDGE_DEFAULT_PORT } from '../../services/blender/bridgeProtocol.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import * as path from 'node:path'

/** The bridge's master gate IS the Blender dev-lanes gate (the ruling
 *  above). LIVE env read every call, the cores' own reader. */
export function blenderBridgeEnabled(): boolean {
  return mercuryBlenderEnabled()
}

// Blender has no project-root marker — the .blend IS the unit of work
// (blenderProject.ts's own sentence), so the catalog's context truth is the
// bounded .blend walk. It is a downward walk (≤4000 dir visits), not the
// unity gate's cheap upward marker probe, so the answer is cached briefly:
// a foreign repo with the flag armed pays the walk once per window, not per
// catalog build.
const BLEND_CONTEXT_CACHE_TTL_MS = 30_000
let blendContextCache: { at: number; cwd: string; has: boolean } | null = null

/** TEST-ONLY: drop the blend-context cache. */
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

/** Catalog seam for tools.ts (the unityBridgeToolCatalogEnabled mirror):
 *  the `Blender` tool registers only armed AND in a .blend context (the
 *  bounded walk finds at least one .blend) — never a ghost tool in a
 *  foreign repo; Blender absence still answers with teaching notes at call
 *  time. */
export function blenderBridgeToolCatalogEnabled(): boolean {
  return blenderBridgeEnabled() && hasBlendContext()
}

/** The port Mercury dials (the ADD-ON listens per the config.json beside
 *  it; install aligns the halves — see services/blender/bridgeInstaller.ts). */
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

/** Proof/embedder seam: overrides the per-install token (never logged). */
export function blenderBridgeTokenOverride(): string | undefined {
  const raw = flagEnv('MERCURY_BLENDER_BRIDGE_TOKEN')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}

/** The installer's home pin (AUTHORITATIVE when set; the MERCURY_BLENDER_BIN
 *  grammar — a broken pin refuses NAMING the pin at the installer, where
 *  the refusal can teach). */
export function blenderBridgeAddonDirOverride(): string | undefined {
  const raw = flagEnv('MERCURY_BLENDER_BRIDGE_ADDON_DIR')
  return raw && raw.trim().length > 0 ? raw.trim() : undefined
}
