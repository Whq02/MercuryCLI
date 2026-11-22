import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'


type SessionSettingsCacheValue = Unbuilt

export function getSessionSettingsCache(): SessionSettingsCacheValue | null {
  return notBuilt('src/utils/settings/settingsCache.ts:12')
}

export function setSessionSettingsCache(value: SessionSettingsCacheValue | null): void {
  return notBuilt('src/utils/settings/settingsCache.ts:16')
}

export function getCachedSettingsForSource(source: SettingSource): SettingsJson | null | undefined {
  return notBuilt('src/utils/settings/settingsCache.ts:20')
}

export function setCachedSettingsForSource(source: SettingSource, value: SettingsJson | null): void {
  return notBuilt('src/utils/settings/settingsCache.ts:24')
}

export function getCachedParsedFile(
  path: string,
): { settings: SettingsJson | null; errors: unknown[] } | undefined {
  return notBuilt('src/utils/settings/settingsCache.ts:28')
}

export function setCachedParsedFile(
  path: string,
  value: { settings: SettingsJson | null; errors: unknown[] },
): void {
  return notBuilt('src/utils/settings/settingsCache.ts:34')
}

export function getLastGoodParsedFile(path: string): SettingsJson | undefined {
  return notBuilt('src/utils/settings/settingsCache.ts:41')
}

export function setLastGoodParsedFile(path: string, settings: SettingsJson): void {
  return notBuilt('src/utils/settings/settingsCache.ts:45')
}

export function forgetLastGoodParsedFile(path: string): void {
  return notBuilt('src/utils/settings/settingsCache.ts:49')
}

export function resetSettingsCache(): void {
  return notBuilt('src/utils/settings/settingsCache.ts:53')
}
