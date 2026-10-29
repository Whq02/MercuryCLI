import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'

type SessionSettingsCacheValue = { settings: SettingsJson; errors: unknown[] }

let sessionSettingsCache: SessionSettingsCacheValue | null = null

const perSourceCache = new Map<SettingSource, SettingsJson | null>()
const parsedFileCache = new Map<string, { settings: SettingsJson | null; errors: unknown[] }>()
const lastGoodParsedFile = new Map<string, SettingsJson>()

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

export function getLastGoodParsedFile(path: string): SettingsJson | undefined {
  return lastGoodParsedFile.get(path)
}

export function setLastGoodParsedFile(path: string, settings: SettingsJson): void {
  lastGoodParsedFile.set(path, settings)
}

export function forgetLastGoodParsedFile(path: string): void {
  lastGoodParsedFile.delete(path)
}

export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parsedFileCache.clear()
}
