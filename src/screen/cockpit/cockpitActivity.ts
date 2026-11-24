
import { useSyncExternalStore } from 'react'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import { createSignal } from '../../platform/async/signal.js'

export type ActivityState =
  | 'calm'
  | 'active'
  | 'waiting'
  | 'review'

let state: ActivityState = 'calm'
const changed = createSignal()

export function publishCockpitActivity(next: ActivityState): void {
  if (next === state) return
  state = next
  fluxMark(`activity:${next}`)
  changed.emit()
}

export function getCockpitActivity(): ActivityState {
  return state
}

export const subscribeCockpitActivity = changed.subscribe

export function useCockpitActivity(): ActivityState {
  return useSyncExternalStore(
    subscribeCockpitActivity,
    getCockpitActivity,
    getCockpitActivity,
  )
}

export function resetCockpitActivityForTests(): void {
  state = 'calm'
  changed.clear()
}
