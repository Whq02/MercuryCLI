
import * as path from 'node:path'
import {
  discoverSpriteFiles,
  locateAseprite,
  mercuryAsepriteEnabled,
} from '../../services/aseprite/asepriteApp.js'
import { getCwd } from '../cwd.js'

export function asepriteEnabled(): boolean {
  return mercuryAsepriteEnabled()
}

const CONTEXT_CACHE_TTL_MS = 30_000
let contextCache: { at: number; cwd: string; has: boolean } | null = null
let locatedCache: { at: number; has: boolean } | null = null

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

export function asepriteToolCatalogEnabled(): boolean {
  return asepriteEnabled() && (hasSpriteContext() || hasLocatedApp())
}
