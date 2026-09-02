import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'


type SessionSettingsCacheValue = { settings: SettingsJson; errors: unknown[] }

let sessionSettingsCache: SessionSettingsCacheValue | null = null
const perSourceCache = new Map<SettingSource, SettingsJson | null>()
const parsedFileCache = new Map<string, { settings: SettingsJson | null; errors: unknown[] }>()

export function getSessionSettingsCache(): SessionSettingsCacheValue | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(value: SessionSettingsCacheValue | null): void {
  sessionSettingsCache = value
}

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

export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parsedFileCache.clear()
}
