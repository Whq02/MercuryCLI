
import { useAppState, useAppStateMaybeOutsideOfProvider } from '../app-state/AppState.js'
import type { AppState } from '../app-state/AppStateStore.js'
import type { SettingsJson } from '../../platform/settings/settingsSchema.js'

type ReadonlySettings = Readonly<SettingsJson>

export function useSettings(): ReadonlySettings {
  return useAppState((state: AppState) => state.settings) as ReadonlySettings
}

export function useSettingsMaybe(): ReadonlySettings | undefined {
  return useAppStateMaybeOutsideOfProvider(
    (state: AppState) => state.settings,
  ) as ReadonlySettings | undefined
}
