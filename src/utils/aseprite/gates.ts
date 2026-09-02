// ============================================================================
//  aseprite/gates — the Aseprite batch door's gate module (the
//  blender/bridgeGates sibling). THE ONE-SWITCH RULING carries over: the
//  tool RIDES MERCURY_ASEPRITE — the one Aseprite switch — with no _TOOLS
//  sibling. Lawful because the door splices NO prompt bytes (no prompt
//  section, no subagent-doctrine line — the tool description carries the
//  teaching), so the flag's additive tier stands: flag off ⇒ no `Aseprite`
//  tool in the catalog, no spawn, no harness-map line, nothing dialed.
//
//  Catalog context (the deliberate widening over the Blender gate, reasoned
//  here): Aseprite, like Blender, has no project-root marker — the sprite
//  file is the unit of work, so a bounded .aseprite/.ase walk is one
//  context truth. But the batch door can also START from nothing
//  (op:"create" births a sprite into an empty tree), so a LOCATED app is
//  the other: armed AND (sprites found OR the app located). Neither rung
//  makes a ghost — located ⇒ create works anywhere; sprites-without-app ⇒
//  the tool teaches the install roads at call time (the Blender grammar).
//  Armed with neither, a foreign repo stays clean: no tool.
// ============================================================================

import * as path from 'node:path'
import {
  discoverSpriteFiles,
  locateAseprite,
  mercuryAsepriteEnabled,
} from '../../services/aseprite/asepriteApp.js'
import { getCwd } from '../cwd.js'

/** The door's master gate IS the Aseprite dev-lanes gate (the ruling
 *  above). LIVE env read every call. */
export function asepriteEnabled(): boolean {
  return mercuryAsepriteEnabled()
}

// The sprite walk is a downward walk (≤4000 dir visits) and location is a
// short stat/PATH census; both answers are cached briefly so a foreign repo
// with the flag armed pays them once per window, not per catalog build.
const CONTEXT_CACHE_TTL_MS = 30_000
let contextCache: { at: number; cwd: string; has: boolean } | null = null
let locatedCache: { at: number; has: boolean } | null = null

/** TEST-ONLY: drop the catalog-context caches. */
export function _resetAsepriteContextCacheForTesting(): void {
  contextCache = null
  locatedCache = null
}

function hasSpriteContext(): boolean {
  const cwd = path.resolve(getCwd())
  if (
    contextCache &&
    contextCache.cwd === cwd &&
    Date.now() - contextCache.at < CONTEXT_CACHE_TTL_MS
  ) {
    return contextCache.has
  }
  const has = discoverSpriteFiles(cwd).total > 0
  contextCache = { at: Date.now(), cwd, has }
  return has
}

function hasLocatedApp(): boolean {
  if (locatedCache && Date.now() - locatedCache.at < CONTEXT_CACHE_TTL_MS) {
    return locatedCache.has
  }
  const census = locateAseprite()
  const has = census.aseprite !== undefined
  locatedCache = { at: Date.now(), has }
  return has
}

/** Catalog seam for tools.ts (the blenderBridgeToolCatalogEnabled mirror,
 *  widened by the located rung — the header's reasoning): the `Aseprite`
 *  tool registers only armed AND in a sprite context OR with the app
 *  located. Absence of the app still answers with teaching notes at call
 *  time. */
export function asepriteToolCatalogEnabled(): boolean {
  return asepriteEnabled() && (hasSpriteContext() || hasLocatedApp())
}
