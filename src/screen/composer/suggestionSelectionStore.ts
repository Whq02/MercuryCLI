
import { useSyncExternalStore } from 'react'
import { passedOver } from '../../platform/errors/passedOver.js'

let selected = -1
const listeners = new Set<() => void>()

export function getSelectedSuggestion(): number {
  return selected
}

export function setSelectedSuggestionStore(n: number): void {
  if (n === selected) return
  selected = n
  for (const cb of listeners) {
    try {
      cb()
    } catch (error) {
      passedOver(error)
    }
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useSelectedSuggestion(): number {
  return useSyncExternalStore(subscribe, getSelectedSuggestion)
}
