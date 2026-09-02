/**
 * Dependency-LEAF state for remote managed settings: the session cache, the
 * tri-state eligibility mirror, the on-disk path and the synchronous disk
 * read.
 *
 * This module must not import the auth layer — the split is load-bearing:
 * only the eligibility predicate (a separate module) touches auth and writes
 * its verdict here, which is what keeps the settings reader out of a cycle
 * through auth and back into settings.
 */
import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import { readFileSync } from '../../utils/fileRead.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { jsonParse } from '../../utils/slowOperations.js'

/** The in-memory copy of the active remote settings for this process. */
let sessionCache: SettingsJson | null = null

/** Tri-state: undefined = undetermined, else the computed verdict. */
let eligibility: boolean | undefined = undefined

/** The merged-settings cache is invalidated at most ONCE on first disk load. */
let invalidatedMergedCacheOnce = false

/** The on-disk cache: `remote-settings.json` in the product home. */
export function getSettingsPath(): string {
  return join(getMercuryHome(), 'remote-settings.json')
}

export function setSessionCache(value: SettingsJson | null): void {
  sessionCache = value
}

/** Record the eligibility verdict (returns its argument for call-chaining). */
export function setEligibility(value: boolean): boolean {
  eligibility = value
  return value
}

/** The recorded verdict, or undefined while undetermined. */
export function getEligibility(): boolean | undefined {
  return eligibility
}

/**
 * The synchronous cache read the settings pipeline calls. Returns nothing
 * unless eligibility is known-true; the session cache when populated;
 * otherwise a synchronous disk read (BOM tolerated; non-object and array
 * payloads and any read/parse error read as "no cache"). The FIRST
 * successful disk load populates the session cache and invalidates the
 * merged-settings cache exactly once — any merged result computed before
 * that moment was missing the policy layer.
 */
export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (eligibility !== true) return null
  if (sessionCache !== null) return sessionCache
  let parsed: unknown
  try {
    // The shared file-read and JSON helpers (BOM tolerated).
    parsed = jsonParse(stripBOM(readFileSync(getSettingsPath())))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  sessionCache = parsed as SettingsJson
  if (!invalidatedMergedCacheOnce) {
    invalidatedMergedCacheOnce = true
    resetSettingsCache()
  }
  return sessionCache
}

/** Clear the session cache and the eligibility mirror (back to undetermined). */
export function resetSyncCache(): void {
  sessionCache = null
  eligibility = undefined
  invalidatedMergedCacheOnce = false
}
