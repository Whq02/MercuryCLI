import { getInitialSettings, updateSettingsForSource } from '../settings/settings.js'

export type CritterSize = 'mini' | 'full'

let sizeUnsaved: CritterSize | null = null
const sizeListeners = new Set<() => void>()

export function getCritterSize(): CritterSize {
  if (sizeUnsaved !== null) return sizeUnsaved
  return getInitialSettings().critterSize === 'full' ? 'full' : 'mini'
}

export function setCritterSize(size: CritterSize): void {
  const { error } = updateSettingsForSource('userSettings', { critterSize: size })
  sizeUnsaved = error === null ? null : size
  for (const l of sizeListeners) l()
}

export function subscribeCritterSize(onChange: () => void): () => void {
  sizeListeners.add(onChange)
  return () => {
    sizeListeners.delete(onChange)
  }
}
