
import { useAppState, useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { SettingsJson } from '../utils/settings/types.js'

export type ReadonlySettings = Readonly<SettingsJson>

export function useSettings(): ReadonlySettings {
  return useAppState((state: AppState) => state.settings) as ReadonlySettings
}

export function useSettingsMaybe(): ReadonlySettings | undefined {
  return useAppStateMaybeOutsideOfProvider(
    (state: AppState) => state.settings,
  ) as ReadonlySettings | undefined
}
