import { join } from 'node:path'

import { getMercuryHome } from '../../utils/envUtils.js'
import { readFileSync } from '../../utils/fileRead.js'
import { stripBOM } from '../../utils/jsonRead.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { jsonParse } from '../../utils/slowOperations.js'

let sessionCache: SettingsJson | null = null

let eligibility: boolean | undefined = undefined

let invalidatedMergedCacheOnce = false

export function getSettingsPath(): string {
  return join(getMercuryHome(), 'remote-settings.json')
}

export function setSessionCache(value: SettingsJson | null): void {
  sessionCache = value
}

export function setEligibility(value: boolean): boolean {
  eligibility = value
  return value
}

export function getEligibility(): boolean | undefined {
  return eligibility
}

export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  if (eligibility !== true) return null
  if (sessionCache !== null) return sessionCache
  let parsed: unknown
  try {
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

export function resetSyncCache(): void {
  sessionCache = null
  eligibility = undefined
  invalidatedMergedCacheOnce = false
}
