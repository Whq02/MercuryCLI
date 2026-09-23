import { getInitialSettings, updateSettingsForSource } from '../settings/settings.js'

let barUnsaved: boolean | null = null
const barListeners = new Set<() => void>()

export function isSessionsBarOn(): boolean {
  if (barUnsaved !== null) return barUnsaved
  return getInitialSettings().sessionsBar === true
}

export function setSessionsBar(on: boolean): void {
  const { error } = updateSettingsForSource('userSettings', { sessionsBar: on })
  barUnsaved = error === null ? null : on
  for (const l of barListeners) l()
}

export function subscribeSessionsBar(onChange: () => void): () => void {
  barListeners.add(onChange)
  return () => {
    barListeners.delete(onChange)
  }
}
