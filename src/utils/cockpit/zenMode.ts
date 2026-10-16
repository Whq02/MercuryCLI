import { currentSurfaceRoute, getRouteSurface } from '../../context/surfaceRoute.js'
import { settingsChangeDetector } from '../settings/changeDetector.js'
import { updateSettingsForSource } from '../settings/settings.js'
import { getSettingsSnapshot } from '../settings/snapshot.js'

export function zenModeOn(): boolean {
  return getSettingsSnapshot().settings.view?.zen === true
}

export function zenRailsHidden(): boolean {
  return zenModeOn() && getRouteSurface(currentSurfaceRoute().kind) === undefined
}

export function setZenMode(on: boolean): Error | null {
  const { error } = updateSettingsForSource('userSettings', { view: { zen: on ? true : undefined } })
  if (error !== null) return error
  settingsChangeDetector.notifyChange('userSettings')
  return null
}
