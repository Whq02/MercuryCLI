
import { useSyncExternalStore } from 'react'
import { fluxMark } from '../flux/fluxProbe.js'

export type ActivityState =
  | 'calm'
  | 'active'
  | 'waiting'
  | 'review'

let state: ActivityState = 'calm'
const listeners = new Set<() => void>()

export function publishCockpitActivity(next: ActivityState): void {
  if (next === state) return
  state = next
  fluxMark(`activity:${next}`)
  for (const listener of listeners) listener()
}

export function getCockpitActivity(): ActivityState {
  return state
}

export function subscribeCockpitActivity(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function useCockpitActivity(): ActivityState {
  return useSyncExternalStore(
    subscribeCockpitActivity,
    getCockpitActivity,
    getCockpitActivity,
  )
}

export function resetCockpitActivityForTests(): void {
  state = 'calm'
  listeners.clear()
}
