// Reactive read of settings from application state; files changing
// on disk update the state elsewhere.

import { useAppState, useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { SettingsJson } from '../utils/settings/types.js'

export type ReadonlySettings = Readonly<SettingsJson>

export function useSettings(): ReadonlySettings {
  return useAppState((state: AppState) => state.settings) as ReadonlySettings
}

/** Provider-tolerant settings read for components that also mount in
 *  DETACHED Ink roots (renderToAnsiString static prints — /context, export
 *  renders): outside an AppStateProvider it answers undefined instead of
 *  throwing, so a decorative reader degrades (e.g. reduced-motion defaults
 *  off and the settled frame renders). Interactive mounts read identically
 *  to useSettings. The /context blank-screen bug was exactly this class:
 *  the wordmark's shimmer reached useSettings and threw the whole print
 *  away. */
export function useSettingsMaybe(): ReadonlySettings | undefined {
  return useAppStateMaybeOutsideOfProvider(
    (state: AppState) => state.settings,
  ) as ReadonlySettings | undefined
}
