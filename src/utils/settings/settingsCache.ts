import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'

/**
 * Three caches — the merged session cache, the per-source cache, and the
 * per-file parse cache — with one shared reset.
 */

type SessionSettingsCacheValue = { settings: SettingsJson; errors: unknown[] }

let sessionSettingsCache: SessionSettingsCacheValue | null = null
// Three-state per source: absent (miss), null (source has nothing), object.
const perSourceCache = new Map<SettingSource, SettingsJson | null>()
const parsedFileCache = new Map<string, { settings: SettingsJson | null; errors: unknown[] }>()

export function getSessionSettingsCache(): SessionSettingsCacheValue | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(value: SessionSettingsCacheValue | null): void {
  sessionSettingsCache = value
}

/** undefined = miss; null = cached "this source has nothing". */
export function getCachedSettingsForSource(source: SettingSource): SettingsJson | null | undefined {
  return perSourceCache.has(source) ? perSourceCache.get(source) ?? null : undefined
}

export function setCachedSettingsForSource(source: SettingSource, value: SettingsJson | null): void {
  perSourceCache.set(source, value)
}

export function getCachedParsedFile(
  path: string,
): { settings: SettingsJson | null; errors: unknown[] } | undefined {
  return parsedFileCache.get(path)
}

export function setCachedParsedFile(
  path: string,
  value: { settings: SettingsJson | null; errors: unknown[] },
): void {
  parsedFileCache.set(path, value)
}

/** Clears all three caches (called after writes and by the change detector before notifying). */
export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parsedFileCache.clear()
}
